const PLAYHQ_BASE = "https://api.playhq.com";

async function playhq(endpoint, apiKey, version = "v1") {
  if (!apiKey) throw new Error("PLAYHQ_API_KEY is not configured");
  const response = await fetch(`${PLAYHQ_BASE}/${version}${endpoint}`, {
    headers: { "x-api-key": apiKey, "x-phq-tenant": "afl", Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`PlayHQ ${response.status}: ${response.statusText}`);
  return response.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function kickoffToUtcIso(dateStr, timeStr, timeZone) {
  if (!dateStr || !timeStr) return null;
  const tz = timeZone || "Australia/Perth";
  const naive = new Date(`${dateStr}T${timeStr}Z`);
  const asTz = new Date(naive.toLocaleString("en-US", { timeZone: tz }));
  const asUtc = new Date(naive.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(naive.getTime() + asUtc.getTime() - asTz.getTime()).toISOString();
}

function suppliedPasscode(request) {
  return request.headers.get("x-admin-passcode") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
}

function requireAdmin(request, env) {
  if (!env.ADMIN_PASSCODE) throw new Error("ADMIN_PASSCODE is not configured for this Worker");
  if (suppliedPasscode(request) !== env.ADMIN_PASSCODE) throw new Error("Admin authentication failed");
}

async function getSeasons(db) {
  const { results } = await db.prepare(`SELECT id, season_year, playhq_season_id, organisation_id, association_id, status FROM seasons ORDER BY season_year DESC`).all();
  return results;
}

async function getTeams(db, seasonYear = null) {
  const query = seasonYear
    ? `SELECT t.id, t.season_id, t.team_name, t.club_name, t.grade_id, t.grade_name, t.playhq_team_id, s.season_year FROM teams t JOIN seasons s ON s.id=t.season_id WHERE s.season_year=? ORDER BY t.grade_name, t.team_name`
    : `SELECT t.id, t.season_id, t.team_name, t.club_name, t.grade_id, t.grade_name, t.playhq_team_id, s.season_year FROM teams t JOIN seasons s ON s.id=t.season_id ORDER BY s.season_year DESC, t.grade_name, t.team_name`;
  const statement = seasonYear ? db.prepare(query).bind(seasonYear) : db.prepare(query);
  const { results } = await statement.all();
  return results;
}

async function getMembers(db) {
  const { results } = await db.prepare(`SELECT id, first_name, last_name, role FROM member_directory ORDER BY last_name, first_name`).all();
  return results;
}

async function setupSeason(db, payload) {
  const season = payload?.season || {};
  const year = Number(season.year);
  if (!Number.isInteger(year) || !season.uuid || !season.organisationId || !season.associationId) {
    throw new Error("Season year, season UUID, organisation UUID, and association UUID are required");
  }
  await db.prepare(`INSERT INTO seasons (season_year, playhq_season_id, organisation_id, association_id, status) VALUES (?, ?, ?, ?, ?) ON CONFLICT(playhq_season_id) DO UPDATE SET season_year=excluded.season_year, organisation_id=excluded.organisation_id, association_id=excluded.association_id, status=excluded.status`).bind(year, season.uuid.trim(), season.organisationId.trim(), season.associationId.trim(), season.status || "planned").run();
  const seasonRow = await db.prepare(`SELECT id FROM seasons WHERE playhq_season_id=?`).bind(season.uuid.trim()).first();
  const seasonId = seasonRow.id;
  const competition = payload?.competition || {};
  let competitionId = null;
  if (competition.uuid) {
    await db.prepare(`INSERT INTO competitions (season_id, playhq_competition_id, competition_name) VALUES (?, ?, ?) ON CONFLICT(season_id, playhq_competition_id) DO UPDATE SET competition_name=excluded.competition_name`).bind(seasonId, competition.uuid.trim(), competition.name || "Competition").run();
    competitionId = (await db.prepare(`SELECT id FROM competitions WHERE season_id=? AND playhq_competition_id=?`).bind(seasonId, competition.uuid.trim()).first()).id;
  }
  let gradeCount = 0;
  let teamCount = 0;
  for (const grade of payload?.grades || []) {
    if (!grade.uuid || !grade.name) continue;
    await db.prepare(`INSERT INTO grades (season_id, competition_id, playhq_grade_id, grade_name) VALUES (?, ?, ?, ?) ON CONFLICT(season_id, playhq_grade_id) DO UPDATE SET competition_id=excluded.competition_id, grade_name=excluded.grade_name`).bind(seasonId, competitionId, grade.uuid.trim(), grade.name.trim()).run();
    const gradeRow = await db.prepare(`SELECT id FROM grades WHERE season_id=? AND playhq_grade_id=?`).bind(seasonId, grade.uuid.trim()).first();
    gradeCount++;
    for (const team of grade.teams || []) {
      if (!team.uuid || !team.name) continue;
      await db.prepare(`INSERT INTO teams (season_id, playhq_team_id, club_name, team_name, grade_id, grade_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(playhq_team_id) DO UPDATE SET season_id=excluded.season_id, club_name=excluded.club_name, team_name=excluded.team_name, grade_id=excluded.grade_id, grade_name=excluded.grade_name`).bind(seasonId, team.uuid.trim(), team.clubName || "Cockburn Lakes", team.name.trim(), grade.uuid.trim(), grade.name.trim()).run();
      teamCount++;
    }
  }
  for (const [key, value] of Object.entries(payload?.settings || {})) {
    await db.prepare(`INSERT INTO season_config (season_id, config_key, config_value) VALUES (?, ?, ?) ON CONFLICT(season_id, config_key) DO UPDATE SET config_value=excluded.config_value`).bind(seasonId, key, String(value)).run();
  }
  return { seasonId, year, gradeCount, teamCount };
}

async function syncFixtures(db, apiKey, team) {
  const data = await playhq(`/teams/${team.playhq_team_id}/fixture`, apiKey);
  const fixtures = data.data || [];
  for (const fixture of fixtures) {
    const opponent = fixture.competitors?.find((c) => c.id !== team.playhq_team_id);
    await db.prepare(`INSERT INTO fixtures (season_id, team_id, playhq_game_id, round_id, round_name, is_final_round, game_date, game_time, timezone, opponent_team_id, opponent_name, venue_id, venue_name, venue_surface, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(playhq_game_id) DO UPDATE SET season_id=excluded.season_id, team_id=excluded.team_id, round_id=excluded.round_id, round_name=excluded.round_name, is_final_round=excluded.is_final_round, game_date=excluded.game_date, game_time=excluded.game_time, timezone=excluded.timezone, opponent_team_id=excluded.opponent_team_id, opponent_name=excluded.opponent_name, venue_id=excluded.venue_id, venue_name=excluded.venue_name, venue_surface=excluded.venue_surface, status=excluded.status, updated_at=CURRENT_TIMESTAMP`).bind(team.season_id, team.id, fixture.id, fixture.round?.id || null, fixture.round?.name || null, fixture.round?.isFinalRound ? 1 : 0, fixture.schedule?.date || null, fixture.schedule?.time || null, fixture.schedule?.timezone || null, opponent?.id || null, opponent?.name || null, fixture.venue?.id || null, fixture.venue?.name || null, fixture.venue?.surfaceName || null, fixture.status || null).run();
  }
  return fixtures.length;
}

async function syncTeamSheet(db, apiKey, team, gameId = null) {
  let fixture;
  if (gameId) fixture = await db.prepare(`SELECT * FROM fixtures WHERE team_id=? AND playhq_game_id=?`).bind(team.id, gameId).first();
  if (!fixture) fixture = await db.prepare(`SELECT * FROM fixtures WHERE team_id=? AND status!='FINAL' ORDER BY game_date ASC, game_time ASC LIMIT 1`).bind(team.id).first();
  if (!fixture) fixture = await db.prepare(`SELECT * FROM fixtures WHERE team_id=? ORDER BY game_date DESC LIMIT 1`).bind(team.id).first();
  if (!fixture) throw new Error("No fixture found; sync fixtures first");
  const summary = await playhq(`/games/${fixture.playhq_game_id}/summary`, apiKey, "v2");
  const appearances = summary.data?.appearances || [];
  await db.prepare(`DELETE FROM team_sheet_players WHERE game_id=?`).bind(fixture.playhq_game_id).run();
  for (const appearance of appearances.filter((a) => a.teamId === team.playhq_team_id)) {
    await db.prepare(`INSERT OR REPLACE INTO team_sheet_players (game_id, playhq_player_id, first_name, last_name, player_number, player_position, captain_role, is_fill_in, is_emergency, role_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(fixture.playhq_game_id, appearance.id, appearance.firstName || "", appearance.lastName || "", appearance.playerNumber || null, appearance.position || null, appearance.captainRole || null, appearance.isFillIn ? 1 : 0, appearance.isEmergency ? 1 : 0, appearance.roleType || "Player").run();
  }
  return { gameId: fixture.playhq_game_id, round: fixture.round_name, date: fixture.game_date, opponent: fixture.opponent_name, status: fixture.status, playerCount: appearances.filter((a) => a.teamId === team.playhq_team_id && (a.roleType || "Player") === "Player").length };
}

async function recordSync(db, seasonId, teamId, type, status, count, error = null) {
  await db.prepare(`INSERT INTO sync_runs (season_id, team_id, sync_type, status, item_count, error_message) VALUES (?, ?, ?, ?, ?, ?)`).bind(seasonId, teamId, type, status, count, error).run();
}

async function gameDetail(db, apiKey, gameId) {
  const fixture = await db.prepare(`SELECT f.*, t.team_name, t.grade_name, t.club_name, s.season_year FROM fixtures f JOIN teams t ON f.team_id=t.id JOIN seasons s ON f.season_id=s.id WHERE f.playhq_game_id=?`).bind(gameId).first();
  if (!fixture) throw new Error("Game not found in local index; sync its team fixtures first");
  const summary = await playhq(`/games/${gameId}/summary`, apiKey, "v2");
  return { gameId, status: fixture.status, roundId: fixture.round_id, roundName: fixture.round_name, season: String(fixture.season_year), grade: fixture.grade_name, homeTeam: fixture.team_name, awayTeam: fixture.opponent_name, venue: fixture.venue_name, gameDate: fixture.game_date, gameTime: fixture.game_time, kickoffUtc: kickoffToUtcIso(fixture.game_date, fixture.game_time, fixture.timezone), players: (summary.data?.appearances || []).map((p) => ({ playhqPlayerId: p.id, teamId: p.teamId, roleType: p.roleType || "Player", name: `${p.firstName || ""} ${p.lastName || ""}`.trim(), number: p.playerNumber || null, position: p.position || null, captain: p.captainRole || null, isFillIn: !!p.isFillIn, isEmergency: !!p.isEmergency })) };
}

function dashboard() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cockburn Lakes Player Hub</title><style>
:root{--navy:#071b3a;--blue:#113d73;--red:#e54655;--paper:#f7f5ef;--ink:#152238;--muted:#667085}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{background:linear-gradient(115deg,var(--navy),#1f477b);color:white;padding:48px max(24px,calc((100% - 1100px)/2));display:flex;justify-content:space-between;gap:24px;align-items:end}header h1{font-size:clamp(34px,6vw,72px);line-height:.95;margin:0;text-transform:uppercase;letter-spacing:-.05em}header p{margin:12px 0 0;color:#d8e1ee}header aside{border-left:1px solid #ffffff55;padding-left:20px;min-width:150px}header aside strong{font-size:28px;display:block}main{max-width:1100px;margin:0 auto;padding:28px 20px 70px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}.section-title{display:flex;justify-content:space-between;align-items:end;border-bottom:2px solid #d9d7cf;padding:12px 0;margin:18px 0}.section-title span{font-size:11px;color:var(--red);font-weight:800;letter-spacing:.16em}.section-title h2{margin:4px 0 0;font-size:28px;text-transform:uppercase}.card{background:white;border:1px solid #e4e1d9;border-top:5px solid var(--red);padding:18px;box-shadow:0 8px 22px #11223b0c}.card h3{margin:0 0 6px;font-size:18px}.card p{color:var(--muted);font-size:13px;line-height:1.45}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1 1 180px}select,input,textarea,button{width:100%;padding:11px;border:1px solid #cbd3dd;border-radius:5px;font:inherit;background:#fff;color:var(--ink)}textarea{min-height:130px;font-family:ui-monospace,monospace;font-size:12px}button{background:var(--red);border-color:var(--red);color:white;font-weight:700;cursor:pointer}button.secondary{background:var(--blue);border-color:var(--blue)}button.ghost{background:transparent;color:var(--blue);border-color:#b7c2d0}.status{display:none;margin-top:10px;padding:10px;border-left:4px solid var(--blue);background:#e9f0f8;font-size:13px}.status.show{display:block}.status.error{border-color:var(--red);background:#fff0f0;color:#8a2330}.results{margin-top:12px}.game{display:flex;justify-content:space-between;gap:14px;align-items:center;border-bottom:1px solid #eee;padding:12px 0}.game small{display:block;color:var(--muted);margin-top:4px}.game button{width:auto;padding:7px 12px;font-size:12px}.pill{display:inline-block;background:#eaf0f8;color:var(--blue);border-radius:999px;padding:4px 8px;font-size:11px;font-weight:700;margin:2px}.hidden{display:none}.notice{padding:12px;background:#fff8e3;border-left:4px solid #e0a400;font-size:13px}.footer{color:var(--muted);font-size:12px;margin-top:40px}@media(max-width:650px){header{display:block}header aside{border:0;padding:14px 0 0}}
</style></head><body><header><div><div style="font-size:11px;letter-spacing:.18em;font-weight:800;color:#ff8b96">COCKBURN LAKES F.C. · PLAYER HUB</div><h1>Club<br><span style="color:#ff5867">Operations.</span></h1><p>Season data, fixtures, team sheets and matchday tools.</p></div><aside><span style="font-size:11px;color:#b9cae0">ACTIVE SEASON</span><strong id="activeYear">—</strong><span style="font-size:12px;color:#b9cae0">Warriors hub</span></aside></header><main>
<div class="section-title"><div><span>01 / Season browser</span><h2>Find a game.</h2></div></div><div class="card"><div class="row"><select id="season"><option>Loading seasons…</option></select><select id="team" disabled><option>Select a season first</option></select><select id="round" disabled><option>Select a team first</option></select></div><div id="games" class="results"></div><div id="gameDetail" class="results"></div></div>
<div class="section-title"><div><span>02 / Season setup</span><h2>Prepare 2027.</h2></div></div><div class="notice">Enter new PlayHQ UUIDs once they are published. The workflow is repeatable for every future season and does not overwrite historical records.</div><div class="card"><div class="row"><input id="passcode" type="password" placeholder="Admin passcode"><input id="year" type="number" placeholder="Season year, e.g. 2027"><input id="seasonUuid" placeholder="Season UUID"><input id="orgUuid" placeholder="Organisation UUID"><input id="associationUuid" placeholder="Association UUID"><input id="competitionUuid" placeholder="Competition UUID"><input id="competitionName" placeholder="Competition name"></div><p>Paste grades and teams as JSON. The format is an array of grade objects, each containing a UUID, name, and teams array with UUID, name, and optional clubName.</p><textarea id="grades" spellcheck="false">[\n  {\n    "uuid": "grade-uuid",\n    "name": "B Grade Men",\n    "teams": [\n      {"uuid": "team-uuid", "name": "Cockburn Lakes (B)", "clubName": "Cockburn Lakes"}\n    ]\n  }\n]</textarea><br><br><button onclick="saveSeason()">Save season, grades and teams</button><div id="setupStatus" class="status"></div></div>
<div class="section-title"><div><span>03 / Sync desk</span><h2>Bring in live data.</h2></div></div><div class="grid"><div class="card"><h3>Fixture sync</h3><p>Pull every available game for a configured team. Re-running updates schedule changes safely.</p><select id="syncTeam"><option>Loading teams…</option></select><button onclick="syncFixtures()">Sync selected team</button><div id="fixtureStatus" class="status"></div></div><div class="card"><h3>Team sheet sync</h3><p>After fixtures are available, pull the latest team sheet from PlayHQ.</p><select id="sheetTeam"><option>Loading teams…</option></select><button class="secondary" onclick="syncSheet()">Sync latest team sheet</button><div id="sheetStatus" class="status"></div></div></div><p class="footer">Cockburn Lakes Player Hub · Cloudflare Worker · Historical seasons remain available through the season selector.</p></main><script>
const $=id=>document.getElementById(id);let allTeams=[];function show(el,msg,error=false){el.textContent=msg;el.className='status show'+(error?' error':'')}function headers(){const p=$('passcode').value||sessionStorage.getItem('hubPasscode')||'';return {'Content-Type':'application/json','x-admin-passcode':p}}async function api(url,opts={}){const r=await fetch(url,opts);const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d}
async function load(){const s=await api('/api/seasons');$('season').innerHTML='<option value="">Select season…</option>'+s.seasons.map(x=>'<option value="'+x.season_year+'">'+x.season_year+'</option>').join('');if(s.seasons[0]){$('activeYear').textContent=s.seasons[0].season_year;$('season').value=s.seasons[0].season_year;await loadTeams(s.seasons[0].season_year)}}async function loadTeams(year){const d=await api('/api/seasons/'+year+'/teams');allTeams=d.teams||[];$('team').innerHTML='<option value="">Select team…</option>'+allTeams.map(t=>'<option value="'+t.id+'">'+(t.grade_name?t.grade_name+' — ':'')+t.team_name+'</option>').join('');$('team').disabled=false;const opts='<option value="">Select team…</option>'+allTeams.map(t=>'<option value="'+t.id+'">'+t.grade_name+' — '+t.team_name+'</option>').join('');$('syncTeam').innerHTML=opts;$('sheetTeam').innerHTML=opts}
$('season').onchange=async e=>{if(!e.target.value)return; $('activeYear').textContent=e.target.value;await loadTeams(e.target.value)};$('team').onchange=async e=>{const t=e.target.value;$('round').disabled=!t;$('games').innerHTML='';if(!t)return;const d=await api('/api/teams/'+t+'/rounds');$('round').innerHTML='<option value="">Select round…</option>'+d.rounds.map(r=>'<option value="'+r.round_id+'">'+(r.round_name||'Unscheduled')+'</option>').join('')};$('round').onchange=async e=>{if(!e.target.value)return;const d=await api('/api/teams/'+$('team').value+'/rounds/'+e.target.value);$('games').innerHTML=d.games.map(g=>'<div class="game"><div><b>'+g.our_team_name+' vs '+(g.opponent_name||'TBC')+'</b><small>'+(g.game_date||'TBC')+' '+(g.game_time||'')+' · '+(g.status||'SCHEDULED')+'</small></div><button data-game="'+g.playhq_game_id+'">OPEN</button></div>').join('')||'<p>No games found.</p>';document.querySelectorAll('[data-game]').forEach(b=>b.onclick=()=>openGame(b.dataset.game))};async function openGame(id){try{const d=await api('/api/game/'+id);$('gameDetail').innerHTML='<div class="card"><b>'+d.homeTeam+' vs '+d.awayTeam+'</b><p>'+d.roundName+' · '+d.gameDate+' · '+(d.venue||'Venue TBC')+'</p>'+d.players.filter(p=>p.roleType==='Player').map(p=>'<span class="pill">'+(p.number?'#'+p.number+' ':'')+p.name+'</span>').join('')+'</div>'}catch(e){$('gameDetail').textContent=e.message}}
async function saveSeason(){try{sessionStorage.setItem('hubPasscode',$('passcode').value);const d=await api('/api/setup',{method:'POST',headers:headers(),body:JSON.stringify({season:{year:$('year').value,uuid:$('seasonUuid').value,organisationId:$('orgUuid').value,associationId:$('associationUuid').value,status:'planned'},competition:{uuid:$('competitionUuid').value,name:$('competitionName').value},grades:JSON.parse($('grades').value)})});show($('setupStatus'),'Saved '+d.year+' · '+d.gradeCount+' grades · '+d.teamCount+' teams');await load()}catch(e){show($('setupStatus'),e.message,true)}}async function syncFixtures(){try{const d=await api('/api/sync-fixtures',{method:'POST',headers:headers(),body:JSON.stringify({teamId:$('syncTeam').value})});show($('fixtureStatus'),'Synced '+d.count+' fixtures for '+d.teamName)}catch(e){show($('fixtureStatus'),e.message,true)}}async function syncSheet(){try{const d=await api('/api/sync-team-sheet',{method:'POST',headers:headers(),body:JSON.stringify({teamId:$('sheetTeam').value})});show($('sheetStatus'),'Synced '+d.playerCount+' players for '+(d.opponent||'latest game'))}catch(e){show($('sheetStatus'),e.message,true)}}load().catch(e=>console.error(e));</script></body></html>`;
}

export default { async fetch(request, env) {
  const url = new URL(request.url); const path = url.pathname;
  if (path.startsWith('/assets/') && env.ASSETS) { const object = await env.ASSETS.get(path.slice(8)); return object ? new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream' } }) : json({ error: 'Asset not found' }, 404); }
  if (path === '/') return html(dashboard());
  try {
    if (path === '/api/seasons' && request.method === 'GET') return json({ seasons: await getSeasons(env.DB) });
    if (path === '/api/teams' && request.method === 'GET') return json({ teams: await getTeams(env.DB) });
    let m;
    if ((m = path.match(/^\/api\/seasons\/([^/]+)\/teams$/)) && request.method === 'GET') return json({ teams: await getTeams(env.DB, m[1]) });
    if ((m = path.match(/^\/api\/teams\/(\d+)\/rounds$/)) && request.method === 'GET') { const { results } = await env.DB.prepare(`SELECT round_id, round_name, MAX(is_final_round) AS is_final_round, MIN(game_date) AS first_date FROM fixtures WHERE team_id=? GROUP BY round_id, round_name ORDER BY first_date`).bind(m[1]).all(); return json({ rounds: results }); }
    if ((m = path.match(/^\/api\/teams\/(\d+)\/rounds\/([^/]+)$/)) && request.method === 'GET') { const { results } = await env.DB.prepare(`SELECT f.playhq_game_id, f.round_name, f.game_date, f.game_time, f.timezone, f.status, f.venue_name, f.opponent_name, t.team_name AS our_team_name FROM fixtures f JOIN teams t ON f.team_id=t.id WHERE f.team_id=? AND f.round_id=? ORDER BY f.game_date, f.game_time`).bind(m[1], m[2]).all(); return json({ games: results.map(g => ({ ...g, kickoff_utc: kickoffToUtcIso(g.game_date, g.game_time, g.timezone) })) }); }
    if ((m = path.match(/^\/api\/game\/([^/]+)$/)) && request.method === 'GET') return json(await gameDetail(env.DB, env.PLAYHQ_API_KEY, m[1]));
    if (path === '/api/members' && request.method === 'GET') return json({ members: await getMembers(env.DB) });
    if (path === '/api/setup' && request.method === 'POST') { requireAdmin(request, env); const result = await setupSeason(env.DB, await request.json()); return json({ success: true, ...result }); }
    if (path === '/api/sync-fixtures' && request.method === 'POST') { requireAdmin(request, env); const { teamId } = await request.json(); const team = await env.DB.prepare(`SELECT * FROM teams WHERE id=?`).bind(teamId).first(); if (!team) throw new Error('Team not found'); try { const count = await syncFixtures(env.DB, env.PLAYHQ_API_KEY, team); await recordSync(env.DB, team.season_id, team.id, 'fixtures', 'success', count); return json({ success: true, count, teamName: team.team_name }); } catch (e) { await recordSync(env.DB, team.season_id, team.id, 'fixtures', 'error', 0, e.message); throw e; } }
    if (path === '/api/sync-team-sheet' && request.method === 'POST') { requireAdmin(request, env); const { teamId, gameId } = await request.json(); const team = await env.DB.prepare(`SELECT * FROM teams WHERE id=?`).bind(teamId).first(); if (!team) throw new Error('Team not found'); const result = await syncTeamSheet(env.DB, env.PLAYHQ_API_KEY, team, gameId); await recordSync(env.DB, team.season_id, team.id, 'team_sheet', 'success', result.playerCount); return json(result); }
    return json({ error: 'Not found' }, 404);
  } catch (e) { return json({ error: e.message || 'Unexpected error' }, e.message === 'Admin authentication failed' ? 401 : 400); }
} };
