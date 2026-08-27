# Cockburn Hub 2027 Upgrade Architecture

## Goal

Keep the existing 2026 Cockburn Hub data and public workflows intact while making future seasons configurable through the admin interface. A season administrator should be able to enter PlayHQ identifiers for a new season, add any number of grades and teams, sync fixtures for each team, and browse games and team sheets without changing Worker code.

## Cloudflare resources

| Resource | Existing resource | Use after upgrade |
|---|---|---|
| Worker | `cockburn-hub` | Public dashboard, JSON API, protected setup/admin routes |
| D1 | `playhq-warriors` (`1163981c-0d16-4ba3-88d7-c8ab13ad800d`) | Existing history plus normalized season, grade, team, fixture, member, and game data |
| R2 | `clfc-assets` | Optional season/team badges and future static assets; no new bucket is required unless the administrator wants isolated asset storage |
| Secret | Existing PlayHQ API key | Server-side only; never exposed to the browser |

## Data model direction

The current `seasons`, `teams`, and `fixtures` tables remain backward-compatible. The migration adds `competitions` and `grades` as explicit season-scoped entities, a `season_config` table for UUID/key-value settings, and `sync_runs` for operational audit history. New UUIDs are stored as text because PlayHQ identifiers are UUID strings and some values (such as tenant identifiers) are not UUIDs. Existing 2026 rows are backfilled into the new entities without changing their integer primary keys or historical feature tables.

The setup API is idempotent. A season is upserted by year and PlayHQ season UUID; a grade is upserted by season and grade UUID; and a team is upserted by season and PlayHQ team UUID. Repeating an import updates labels and identifiers rather than creating duplicates. Fixture synchronization is also idempotent because the existing game UUID uniqueness is preserved.

## Operational workflow

The admin screen exposes a season setup form, a repeatable grade/team editor, a season/team selector, and explicit sync actions. The setup form supports the minimum required inputs: season year and season UUID, organisation UUID, association UUID, competition UUID, grade UUID/name, and team UUID/name. Optional metadata such as club name and display slug can be entered when available. After saving, the operator can sync fixtures for one team or all teams in a season. All sync actions report counts and errors in the UI and append a `sync_runs` record.

## API surface

The upgraded Worker provides read endpoints for seasons, grades, teams, rounds, games, upcoming games, members, and player lists. Protected write endpoints cover season setup, fixture synchronization, player synchronization, and player linking. The existing read paths remain supported so current links and tools continue to work.

## Security and safety

The PlayHQ key remains a Worker secret. Write endpoints require the existing admin passcode mechanism; the public dashboard only performs read operations. SQL statements use bound parameters. Migrations are additive and avoid destructive changes. The deployment manifest binds the existing D1 database and the existing `clfc-assets` R2 bucket for future asset use.

## Deployment

Use Wrangler with a D1 migration directory. Apply migrations remotely against the existing `playhq-warriors` database, then deploy the `cockburn-hub` Worker. The source-of-truth code and migration are committed to GitHub before deployment. Production verification covers the public dashboard, season list, setup API, fixture synchronization path, and the existing admin unlock path.
