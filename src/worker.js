const PLAYHQ_BASE = "https://api.playhq.com";

async function playhq(endpoint, apiKey, version = "v1") {
  const res = await fetch(`${PLAYHQ_BASE}/${version}${endpoint}`, {
    headers: {
      "x-api-key": apiKey,
      "x-phq-tenant": "afl",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`PlayHQ ${res.status}: ${res.statusText}`);
  return res.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Combine a stored "2026-08-08" + "15:35:00" + "Australia/Perth" into a
// single precise UTC instant. PlayHQ gives local kick-off time + an IANA
// zone name, not a UTC offset, so this can't be string-concatenated —
// DST-observing zones would be wrong part of the year otherwise.
// Returns an ISO 8601 string in UTC, or null if date/time isn't set yet
// (happens for early-season rounds PlayHQ hasn't scheduled).
function kickoffToUtcIso(dateStr, timeStr, timeZone) {
  if (!dateStr || !timeStr) return null;
  const tz = timeZone || "Australia/Perth";
  const naive = new Date(`${dateStr}T${timeStr}Z`); // wall-clock time, treated as UTC for now
  const asTz = new Date(naive.toLocaleString("en-US", { timeZone: tz }));
  const asUtc = new Date(naive.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = asUtc.getTime() - asTz.getTime();
  return new Date(naive.getTime() + offsetMs).toISOString();
}

// ---------------------------------------------------------------------------
// Teams / members (live)
// ---------------------------------------------------------------------------

async function getTeams(db) {
  const { results } = await db.prepare(
    `SELECT id, team_name, playhq_team_id, grade_name FROM teams ORDER BY id`
  ).all();
  return results;
}

async function getMembers(db) {
  const { results } = await db.prepare(
    `SELECT id, first_name, last_name, role FROM member_directory ORDER BY last_name, first_name`
  ).all();
  return results;
}

async function getMemberPin(db, memberId) {
  const row = await db.prepare(
    `SELECT id, first_name, last_name, pin FROM member_directory WHERE id = ?`
  ).bind(memberId).first();
  return row;
}

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

async function syncFixtures(db, apiKey, teamId, teamDbId, seasonId) {
  const data = await playhq(`/teams/${teamId}/fixture`, apiKey);
  const fixtures = data.data || [];
  let count = 0;
  for (const f of fixtures) {
    const opponent = f.competitors?.find((c) => c.id !== teamId);
    await db.prepare(`
      INSERT OR REPLACE INTO fixtures 
      (season_id, team_id, playhq_game_id, round_id, round_name, is_final_round,
       game_date, game_time, timezone, opponent_team_id, opponent_name,
       venue_id, venue_name, venue_surface, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      seasonId,
      teamDbId,
      f.id,
      f.round?.id || null,
      f.round?.name || null,
      f.round?.isFinalRound ? 1 : 0,
      f.schedule?.date || null,
      f.schedule?.time || null,
      f.schedule?.timezone || null,
      opponent?.id || null,
      opponent?.name || null,
      f.venue?.id || null,
      f.venue?.name || null,
      f.venue?.surfaceName || null,
      f.status || null
    ).run();
    count++;
  }
  return count;
}

async function syncGamePlayers(db, apiKey, teamId, teamDbId) {
  const data = await playhq(`/teams/${teamId}/fixture`, apiKey);
  const fixtures = data.data || [];
  const today = new Date().toISOString().split("T")[0];
  let game = fixtures.find((f) => f.schedule?.date === today);
  if (!game) game = fixtures.find((f) => f.status === "UPCOMING");
  if (!game) game = [...fixtures].reverse().find((f) => f.status === "FINAL");
  if (!game) throw new Error("No game found");

  const gameId = game.id;
  const summary = await playhq(`/games/${gameId}/summary`, apiKey, "v2");
  const appearances = summary.data?.appearances || [];

  // Store every appearance for our team — players AND coaches — with role_type
  // recorded, so nothing is silently dropped. Filtering to "players only, no
  // coaches" happens at query time, not at sync time.
  const ourTeamAppearances = appearances.filter((a) => a.teamId === teamId);

  // Players specifically (role = Player, has a playerNumber) — used for the
  // response payload / wheel-spin style use cases.
  const players = ourTeamAppearances.filter(
    (a) => a.roleType === "Player" && a.playerNumber
  );

  await db.prepare(`DELETE FROM team_sheet_players WHERE game_id = ?`).bind(gameId).run();

  for (const p of ourTeamAppearances) {
    await db.prepare(`
      INSERT OR IGNORE INTO team_sheet_players
      (game_id, playhq_player_id, first_name, last_name, player_number, player_position, captain_role, is_fill_in, is_emergency, role_type)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).bind(
      gameId,
      p.id,
      p.firstName,
      p.lastName,
      p.playerNumber,
      p.position || null,
      p.captainRole || null,
      p.isFillIn ? 1 : 0,
      p.isEmergency ? 1 : 0,
      p.roleType || "Player"
    ).run();
  }

  // Auto-link playhq_player_id to member_directory
  await db.prepare(`
    UPDATE member_directory
    SET playhq_player_id = (
      SELECT tsp.playhq_player_id
      FROM team_sheet_players tsp
      WHERE LOWER(TRIM(tsp.first_name)) = LOWER(TRIM(member_directory.first_name))
      AND LOWER(TRIM(tsp.last_name)) = LOWER(TRIM(member_directory.last_name))
      LIMIT 1
    )
    WHERE playhq_player_id IS NULL
  `).run();

  return {
    gameId,
    round: game.round?.name,
    date: game.schedule?.date,
    opponent: game.competitors?.find((c) => c.id !== teamId)?.name,
    status: game.status,
    playerCount: players.length,
    players: players.map((p) => ({
      number: p.playerNumber,
      name: `${p.firstName} ${p.lastName}`,
      isFillIn: p.isFillIn,
      isEmergency: p.isEmergency,
      captain: p.captainRole || null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Season -> Team -> Round -> Game browse endpoints
// ---------------------------------------------------------------------------

async function getSeasons(db) {
  const { results } = await db.prepare(`
    SELECT id, season_year, playhq_season_id, organisation_id, association_id, status
    FROM seasons
    ORDER BY season_year DESC
  `).all();
  return results;
}

async function getTeamsForSeason(db, seasonYear) {
  const { results } = await db.prepare(`
    SELECT t.id, t.team_name, t.club_name, t.grade_id, t.grade_name, t.playhq_team_id
    FROM teams t
    JOIN seasons s ON t.season_id = s.id
    WHERE s.season_year = ?
    ORDER BY t.grade_name, t.team_name
  `).bind(seasonYear).all();
  return results;
}

async function getRoundsForTeam(db, teamId) {
  const { results } = await db.prepare(`
    SELECT round_id, round_name, MAX(is_final_round) AS is_final_round, MIN(game_date) AS first_date
    FROM fixtures
    WHERE team_id = ?
    GROUP BY round_id, round_name
    ORDER BY first_date
  `).bind(teamId).all();
  return results;
}

async function getRoundGames(db, teamId, roundId) {
  const { results } = await db.prepare(`
    SELECT f.playhq_game_id, f.round_name, f.game_date, f.game_time, f.timezone,
           f.status, f.venue_name, f.opponent_name, t.team_name AS our_team_name
    FROM fixtures f
    JOIN teams t ON f.team_id = t.id
    WHERE f.team_id = ? AND f.round_id = ?
  `).bind(teamId, roundId).all();
  return results.map((g) => ({
    ...g,
    kickoff_utc: kickoffToUtcIso(g.game_date, g.game_time, g.timezone),
  }));
}

// Upcoming games for a team, soonest first, with a precise kickoff instant
// attached — this is what a "lock the wheel at game time" feature reads.
async function getUpcomingGames(db, teamId, limit = 5) {
  const { results } = await db.prepare(`
    SELECT playhq_game_id, round_name, game_date, game_time, timezone,
           status, venue_name, opponent_name
    FROM fixtures
    WHERE team_id = ? AND status != 'FINAL'
    ORDER BY game_date ASC, game_time ASC
    LIMIT ?
  `).bind(teamId, limit).all();
  return results.map((g) => ({
    ...g,
    kickoff_utc: kickoffToUtcIso(g.game_date, g.game_time, g.timezone),
  }));
}

// Players only (no coaches) for a synced game — reads from the local DB,
// no PlayHQ call. This is what a wheel-spin / random-selection feature
// should query against.
async function getGamePlayersOnly(db, playhqGameId) {
  const { results } = await db.prepare(`
    SELECT playhq_player_id, first_name, last_name, player_number,
           player_position, captain_role, is_fill_in, is_emergency
    FROM team_sheet_players
    WHERE game_id = ? AND role_type = 'Player'
    ORDER BY CAST(player_number AS INTEGER)
  `).bind(playhqGameId).all();
  return results;
}

// Universal lookup: given only a playhq_game_id, resolve everything from D1
// then pull the live team sheet from PlayHQ. Does NOT persist anything —
// this is a read-through endpoint, not a sync.
async function getGameDetail(db, apiKey, playhqGameId) {
  const fixture = await db.prepare(`
    SELECT f.*, t.team_name, t.grade_name, t.club_name, s.season_year
    FROM fixtures f
    JOIN teams t ON f.team_id = t.id
    JOIN seasons s ON f.season_id = s.id
    WHERE f.playhq_game_id = ?
  `).bind(playhqGameId).first();

  if (!fixture) {
    throw new Error("Game not found in local index — run a fixture sync for this team first");
  }

  const summary = await playhq(`/games/${playhqGameId}/summary`, apiKey, "v2");
  const appearances = summary.data?.appearances || [];

  const players = appearances.map((a) => ({
    playhqPlayerId: a.id,
    teamId: a.teamId,
    roleType: a.roleType || "Player",
    name: `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim(),
    number: a.playerNumber ?? null,
    position: a.position || null,
    captain: a.captainRole || null,
    isFillIn: !!a.isFillIn,
    isEmergency: !!a.isEmergency,
  }));

  return {
    gameId: playhqGameId,
    status: fixture.status,
    roundId: fixture.round_id,
    roundName: fixture.round_name,
    season: String(fixture.season_year),
    grade: fixture.grade_name,
    homeTeam: fixture.team_name,
    awayTeam: fixture.opponent_name,
    venue: fixture.venue_name,
    gameDate: fixture.game_date,
    gameTime: fixture.game_time,
    kickoffUtc: kickoffToUtcIso(fixture.game_date, fixture.game_time, fixture.timezone),
    players,
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function getDashboard() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PlayHQ Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --red: #b0193c;
      --blue: #0a3161;
      --blue-light: #1d4e89;
      --white: #ffffff;
      --offwhite: #f4f6f9;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--blue);
      background-image: linear-gradient(180deg, var(--blue) 0%, var(--blue-light) 100%);
      min-height: 100vh; padding: 20px;
      color: var(--blue);
    }
    .container { max-width: 640px; margin: 0 auto; }
    header {
      text-align: center; color: var(--white); margin-bottom: 24px;
      border-bottom: 3px solid var(--red); padding-bottom: 14px;
    }
    header h1 { font-size: 24px; margin-bottom: 4px; letter-spacing: 0.5px; }
    header p { font-size: 13px; opacity: 0.85; }

    .row { display: flex; gap: 16px; flex-wrap: wrap; }
    .row .card { flex: 1 1 260px; }

    .card {
      background: var(--white); padding: 16px; border-radius: 8px;
      box-shadow: 0 4px 10px rgba(0,0,0,0.25); margin-bottom: 16px;
      border-top: 4px solid var(--red);
    }
    .card.blue-accent { border-top-color: var(--blue-light); }
    .card h3 { color: var(--blue); font-size: 15px; margin-bottom: 6px; }
    .card p { color: #555; font-size: 12px; margin-bottom: 12px; line-height: 1.4; }

    select {
      width: 100%; padding: 9px; margin: 6px 0 10px;
      border: 1px solid #cbd3dc; border-radius: 4px; font-size: 13px;
      background: var(--offwhite); color: var(--blue);
    }
    select:disabled { background: #e8ebef; color: #999; }
    button {
      background: var(--red); color: var(--white); padding: 9px 14px;
      border: none; border-radius: 4px; cursor: pointer;
      width: 100%; font-weight: 600; font-size: 13px;
      letter-spacing: 0.3px;
    }
    button:hover { background: #8f142f; }
    button.secondary { background: var(--blue-light); }
    button.secondary:hover { background: #163f6d; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }

    .status { margin-top: 10px; padding: 8px 10px; border-radius: 4px; display: none; font-size: 12px; font-weight: 600; }
    .status.show { display: block; }
    .success { background: #dfeee2; color: #1b5e20; border-left: 4px solid var(--blue-light); }
    .error { background: #fbdede; color: #8a1024; border-left: 4px solid var(--red); }

    .results {
      margin-top: 10px; background: var(--offwhite); padding: 10px;
      border-radius: 4px; max-height: 360px; overflow-y: auto;
      display: none; font-size: 12px; border: 1px solid #dfe4ea;
    }
    .results.show { display: block; }
    .player-list { list-style: none; }
    .player-list li {
      padding: 6px 8px; border-bottom: 1px solid #e4e8ed;
      display: flex; justify-content: space-between;
    }
    .player-list li:last-child { border-bottom: none; }
    .badge {
      font-size: 10px; padding: 2px 6px; border-radius: 10px;
      background: var(--blue-light); color: var(--white); font-weight: 600;
    }
    .badge.fillin { background: var(--red); }
    .badge.captain { background: var(--blue); }

    .pin-reveal {
      text-align: center; padding: 14px; background: var(--offwhite);
      border-radius: 6px; border: 1px dashed var(--blue-light);
    }
    .pin-reveal .pin {
      font-size: 26px; font-weight: 700; letter-spacing: 4px; color: var(--red);
      margin: 6px 0;
    }
    .pin-reveal .name { font-size: 13px; color: var(--blue); font-weight: 600; }

    .game-pick {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px; border: 1px solid #e4e8ed; border-radius: 4px; margin-bottom: 8px;
      font-size: 12px;
    }
    .game-pick button { width: auto; padding: 6px 12px; font-size: 11px; }
    .kickoff { font-size: 11px; color: #777; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🏈 PlayHQ Admin</h1>
      <p>Warriors Hub — Season 2026</p>
    </header>

    <div class="card">
      <h3>🔎 Browse by Season / Team / Round</h3>
      <p>Drill down to a specific game — pulls straight from the local index once fixtures are synced.</p>
      <select id="seasonSelect"><option value="">Loading seasons...</option></select>
      <select id="browseTeamSelect" disabled><option value="">Select a season first</option></select>
      <select id="roundSelect" disabled><option value="">Select a team first</option></select>
      <div id="gamesContainer"></div>
      <div class="status" id="status-browse"></div>
      <div class="results" id="results-browse"></div>
    </div>

    <div class="card">
      <h3>Select Team (for sync actions below)</h3>
      <select id="teamSelect">
        <option value="">Loading teams...</option>
      </select>
    </div>

    <div class="row">
      <div class="card">
        <h3>📅 Fixture Sync</h3>
        <p>Sync all fixtures for the selected team.</p>
        <button onclick="syncFixtures()">Sync Fixtures</button>
        <div class="status" id="status-fixtures"></div>
        <div class="results" id="results-fixtures"></div>
      </div>

      <div class="card blue-accent">
        <h3>👥 Weekly Player Sync</h3>
        <p>Get this week's team sheet and store players.</p>
        <button class="secondary" onclick="syncGame()">Sync Players</button>
        <div class="status" id="status-game"></div>
      </div>
    </div>
    <div class="card blue-accent" id="game-results-card" style="display:none;">
      <h3>Current Team Sheet</h3>
      <div class="results show" id="results-game"></div>
    </div>

    <div class="card">
      <h3>🔑 Member PIN Lookup</h3>
      <p>Select a member to reveal their PIN so you can forward it on.</p>
      <select id="memberSelect">
        <option value="">Loading members...</option>
      </select>
      <button onclick="revealPin()">Reveal PIN</button>
      <div class="status" id="status-pin"></div>
      <div class="results" id="results-pin"></div>
    </div>
  </div>

  <script>
    let teams = [];
    let members = [];

    async function loadTeams() {
      const res = await fetch('/api/teams');
      const data = await res.json();
      teams = data.teams || [];
      const sel = document.getElementById('teamSelect');
      sel.innerHTML = teams.map(t =>
        \`<option value="\${t.id}" data-uuid="\${t.playhq_team_id}">\${t.team_name}</option>\`
      ).join('');
    }

    async function loadMembers() {
      const res = await fetch('/api/members');
      const data = await res.json();
      members = data.members || [];
      const sel = document.getElementById('memberSelect');
      sel.innerHTML = members.map(m =>
        \`<option value="\${m.id}">\${m.last_name}, \${m.first_name}\${m.role ? ' (' + m.role + ')' : ''}</option>\`
      ).join('');
    }

    function getSelected() {
      const sel = document.getElementById('teamSelect');
      const opt = sel.options[sel.selectedIndex];
      return { id: sel.value, uuid: opt?.dataset?.uuid, name: opt?.text };
    }

    function showStatus(id, msg, type) {
      const el = document.getElementById('status-' + id);
      el.innerHTML = msg;
      el.className = 'status show ' + type;
    }

    function showResults(id, html) {
      const el = document.getElementById('results-' + id);
      el.innerHTML = html;
      el.classList.add('show');
    }

    async function syncFixtures() {
      const { id, name } = getSelected();
      if (!id) return alert('Select a team first');
      showStatus('fixtures', 'Syncing...', 'success');
      try {
        const res = await fetch('/api/sync-fixtures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamId: id })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showStatus('fixtures', '✅ ' + data.message, 'success');
        showResults('fixtures', '<pre>' + JSON.stringify(data, null, 2) + '</pre>');
      } catch (e) {
        showStatus('fixtures', '❌ ' + e.message, 'error');
      }
    }

    async function syncGame() {
      const { id, name } = getSelected();
      if (!id) return alert('Select a team first');
      showStatus('game', 'Fetching team sheet...', 'success');
      try {
        const res = await fetch('/api/sync-game', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamId: id })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        const playersHTML = \`
          <p><strong>\${data.round}</strong> — \${data.date} vs \${data.opponent} (\${data.status})</p>
          <p>\${data.playerCount} players</p>
          <ul class="player-list">
            \${data.players.sort((a,b) => a.number - b.number).map(p => \`
              <li>
                <span>#\${p.number} \${p.name}</span>
                <span>
                  \${p.captain ? '<span class="badge captain">C</span>' : ''}
                  \${p.isFillIn ? '<span class="badge fillin">Fill-in</span>' : ''}
                  \${p.isEmergency ? '<span class="badge">EMG</span>' : ''}
                </span>
              </li>
            \`).join('')}
          </ul>
        \`;

        showStatus('game', '✅ Team sheet synced!', 'success');
        document.getElementById('game-results-card').style.display = 'block';
        showResults('game', playersHTML);
      } catch (e) {
        showStatus('game', '❌ ' + e.message, 'error');
      }
    }

    async function revealPin() {
      const sel = document.getElementById('memberSelect');
      const id = sel.value;
      if (!id) return alert('Select a member first');
      showStatus('pin', 'Looking up...', 'success');
      try {
        const res = await fetch('/api/members/' + id + '/pin');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showStatus('pin', '✅ PIN found', 'success');
        showResults('pin', \`
          <div class="pin-reveal">
            <div class="name">\${data.first_name} \${data.last_name}</div>
            <div class="pin">\${data.pin}</div>
          </div>
        \`);
      } catch (e) {
        showStatus('pin', '❌ ' + e.message, 'error');
      }
    }

    // --- Season / Team / Round / Game browser ---

    async function loadSeasons() {
      const res = await fetch('/api/seasons');
      const data = await res.json();
      const sel = document.getElementById('seasonSelect');
      sel.innerHTML = '<option value="">Select season...</option>' + (data.seasons || []).map(s =>
        \`<option value="\${s.season_year}">\${s.season_year}</option>\`
      ).join('');
    }

    document.getElementById('seasonSelect').addEventListener('change', async (e) => {
      const year = e.target.value;
      const teamSel = document.getElementById('browseTeamSelect');
      const roundSel = document.getElementById('roundSelect');
      document.getElementById('gamesContainer').innerHTML = '';
      roundSel.innerHTML = '<option value="">Select a team first</option>';
      roundSel.disabled = true;
      if (!year) {
        teamSel.innerHTML = '<option value="">Select a season first</option>';
        teamSel.disabled = true;
        return;
      }
      teamSel.innerHTML = '<option value="">Loading teams...</option>';
      teamSel.disabled = true;
      const res = await fetch(\`/api/seasons/\${year}/teams\`);
      const data = await res.json();
      teamSel.innerHTML = '<option value="">Select team...</option>' + (data.teams || []).map(t =>
        \`<option value="\${t.id}">\${t.grade_name ? t.grade_name + ' — ' : ''}\${t.team_name}</option>\`
      ).join('');
      teamSel.disabled = false;
    });

    document.getElementById('browseTeamSelect').addEventListener('change', async (e) => {
      const teamId = e.target.value;
      const roundSel = document.getElementById('roundSelect');
      document.getElementById('gamesContainer').innerHTML = '';
      if (!teamId) {
        roundSel.innerHTML = '<option value="">Select a team first</option>';
        roundSel.disabled = true;
        return;
      }
      roundSel.innerHTML = '<option value="">Loading rounds...</option>';
      roundSel.disabled = true;
      const res = await fetch(\`/api/teams/\${teamId}/rounds\`);
      const data = await res.json();
      roundSel.innerHTML = '<option value="">Select round...</option>' + (data.rounds || []).map(r =>
        \`<option value="\${r.round_id}">\${r.round_name}\${r.is_final_round ? ' (Final)' : ''}</option>\`
      ).join('');
      roundSel.disabled = false;
    });

    document.getElementById('roundSelect').addEventListener('change', async (e) => {
      const roundId = e.target.value;
      const teamId = document.getElementById('browseTeamSelect').value;
      const container = document.getElementById('gamesContainer');
      container.innerHTML = '';
      if (!roundId || !teamId) return;
      const res = await fetch(\`/api/teams/\${teamId}/rounds/\${roundId}\`);
      const data = await res.json();
      const games = data.games || [];
      container.innerHTML = games.map(g => \`
        <div class="game-pick">
          <span>
            \${g.our_team_name} vs \${g.opponent_name || 'TBC'} (\${g.status || 'SCHEDULED'})<br>
            <span class="kickoff">\${g.game_date || 'TBC'} \${g.game_time || ''} \${g.timezone || ''}</span>
          </span>
          <button onclick="openGame('\${g.playhq_game_id}')">OPEN</button>
        </div>
      \`).join('') || '<p style="font-size:12px;color:#777;">No games found for this round.</p>';
    });

    async function openGame(playhqGameId) {
      showStatus('browse', 'Loading game...', 'success');
      try {
        const res = await fetch(\`/api/game/\${playhqGameId}\`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showStatus('browse', \`✅ \${data.homeTeam} vs \${data.awayTeam} — \${data.status}\`, 'success');
        const playersHTML = \`
          <p><strong>\${data.roundName}</strong> — \${data.gameDate} — \${data.grade}</p>
          <p>\${data.venue || ''}</p>
          <p class="kickoff">Kickoff (UTC): \${data.kickoffUtc || 'TBC'}</p>
          <ul class="player-list">
            \${data.players.filter(p => p.roleType === 'Player').map(p => \`
              <li>
                <span>\${p.number ? '#' + p.number + ' ' : ''}\${p.name}</span>
                <span>
                  \${p.captain ? '<span class="badge captain">C</span>' : ''}
                  \${p.isFillIn ? '<span class="badge fillin">Fill-in</span>' : ''}
                  \${p.isEmergency ? '<span class="badge">EMG</span>' : ''}
                </span>
              </li>
            \`).join('')}
          </ul>
        \`;
        showResults('browse', playersHTML);
      } catch (e) {
        showStatus('browse', '❌ ' + e.message, 'error');
      }
    }

    loadTeams();
    loadMembers();
    loadSeasons();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      return new Response(getDashboard(), { headers: { "Content-Type": "text/html" } });
    }

    if (path === "/api/teams" && request.method === "GET") {
      const teams = await getTeams(env.DB);
      return json({ teams });
    }

    if (path === "/api/members" && request.method === "GET") {
      try {
        const members = await getMembers(env.DB);
        return json({ members });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    let m;

    if ((m = path.match(/^\/api\/members\/(\d+)\/pin$/)) && request.method === "GET") {
      try {
        const member = await getMemberPin(env.DB, m[1]);
        if (!member) throw new Error("Member not found");
        return json(member);
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/api/seasons" && request.method === "GET") {
      try {
        const seasons = await getSeasons(env.DB);
        return json({ seasons });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if ((m = path.match(/^\/api\/seasons\/([^/]+)\/teams$/)) && request.method === "GET") {
      try {
        const teams = await getTeamsForSeason(env.DB, m[1]);
        return json({ teams });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if ((m = path.match(/^\/api\/teams\/(\d+)\/upcoming$/)) && request.method === "GET") {
      try {
        const limit = Number(url.searchParams.get("limit")) || 5;
        const games = await getUpcomingGames(env.DB, m[1], limit);
        return json({ games });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if ((m = path.match(/^\/api\/teams\/(\d+)\/rounds\/([^/]+)$/)) && request.method === "GET") {
      try {
        const games = await getRoundGames(env.DB, m[1], m[2]);
        return json({ games });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if ((m = path.match(/^\/api\/teams\/(\d+)\/rounds$/)) && request.method === "GET") {
      try {
        const rounds = await getRoundsForTeam(env.DB, m[1]);
        return json({ rounds });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if ((m = path.match(/^\/api\/game\/([^/]+)\/players$/)) && request.method === "GET") {
      try {
        const players = await getGamePlayersOnly(env.DB, m[1]);
        return json({ gameId: m[1], players });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if ((m = path.match(/^\/api\/game\/([^/]+)$/)) && request.method === "GET") {
      try {
        const gameDetail = await getGameDetail(env.DB, env.PLAYHQ_API_KEY, m[1]);
        return json(gameDetail);
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/api/sync-fixtures" && request.method === "POST") {
      try {
        const { teamId } = await request.json();
        const team = await env.DB.prepare(`SELECT * FROM teams WHERE id = ?`).bind(teamId).first();
        if (!team) throw new Error("Team not found");
        const count = await syncFixtures(env.DB, env.PLAYHQ_API_KEY, team.playhq_team_id, team.id, team.season_id);
        return json({ success: true, message: `Synced ${count} fixtures for ${team.team_name}` });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/api/sync-game" && request.method === "POST") {
      try {
        const { teamId } = await request.json();
        const team = await env.DB.prepare(`SELECT * FROM teams WHERE id = ?`).bind(teamId).first();
        if (!team) throw new Error("Team not found");
        const result = await syncGamePlayers(env.DB, env.PLAYHQ_API_KEY, team.playhq_team_id, team.id);
        return json(result);
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/api/link-players" && request.method === "POST") {
      try {
        await env.DB.prepare(`
          UPDATE member_directory
          SET playhq_player_id = (
            SELECT tsp.playhq_player_id
            FROM team_sheet_players tsp
            WHERE LOWER(TRIM(tsp.first_name)) = LOWER(TRIM(member_directory.first_name))
            AND LOWER(TRIM(tsp.last_name)) = LOWER(TRIM(member_directory.last_name))
            LIMIT 1
          )
          WHERE playhq_player_id IS NULL
        `).run();

        const { results } = await env.DB.prepare(`
          SELECT first_name, last_name, playhq_player_id
          FROM member_directory
          WHERE playhq_player_id IS NOT NULL
          ORDER BY last_name
        `).all();

        return json({ success: true, linked: results.length, members: results });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: "Not found" }, 404);
  },
};
