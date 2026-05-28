# Changelog

All notable changes to this project. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **OAuth 2.1 authorization server (for claude.ai web + Claude mobile connectors).** Claude's custom-connector UI on web/mobile only supports OAuth — there's no bearer-token field — so the bearer setup only worked with Claude Code and the Claude Desktop `mcp-remote` bridge. The HTTP server now embeds a full OAuth 2.1 + PKCE authorization server (via the MCP SDK's `mcpAuthRouter` + a custom `OAuthServerProvider`), so the deployed server can be added as a custom connector and synced across every device on your Claude account.
  - **Password gate**: the `/authorize` step serves a small password page; the user enters `AUTH_PASSWORD` once when adding the connector. A stranger who finds the URL still can't connect.
  - **Stateless by design** (survives Fly's auto-stop restarts): access + refresh tokens are HS256 JWTs signed with `MCP_AUTH_TOKEN`; registered clients (dynamic client registration) encode their redirect URIs into a signed `client_id`, so Claude never has to re-register after a cold start. Only the 60-second authorization codes are in-memory.
  - **Backward compatible**: `/mcp` still accepts the static `MCP_AUTH_TOKEN` bearer (Claude Code + Desktop bridge unchanged). `verifyAccessToken` accepts either.
  - New env vars: `AUTH_PASSWORD` (enables the OAuth path) and `PUBLIC_URL` (the OAuth issuer origin). Leave `AUTH_PASSWORD` unset to disable.
  - The HTTP server migrated from raw `node:http` to **Express** (required by the SDK's OAuth router). The per-session McpServer routing is unchanged. 9 new OAuth provider tests + the 9 existing HTTP-auth tests pass (the auth gate now returns spec-correct status codes via the SDK's `requireBearerAuth`).

### Fixed

- **Timezone, both directions.** Two bugs were causing the AI to see wrong clock values:
  - *Output:* `localizeTimestamps` only matched `Z`-suffixed timestamps, but Whoop's journal + pg-range endpoints emit the `+0000` form (e.g. `2026-05-23T07:35:46.220+0000`). Those passed through as UTC. The matcher now catches `Z`, `+0000`, and `+00:00`, all of which mean UTC, and rewrites them to the user's local offset.
  - *Input:* `todayIso()` (the default for ~12 tools' `date` param) computed "today" from the server's calendar day. On a UTC host like Fly, that's a day ahead of the user during their evening, so "how am I doing today" could query tomorrow. It now resolves the calendar day in the configured `WHOOP_TIMEZONE` / auto-detected profile TZ via a new `zonedParts()` helper. `performance_assessment` had the same class of bug (`getTimezoneOffset()` returns 0 on UTC hosts) — fixed to use the configured TZ. 10 new timezone tests (164 total).
- **`whoop_lift_history` description was misleading.** It claimed "set-level detail" but its `sets[]` array is always empty — the `/cardio-details` endpoint only exposes per-exercise aggregates. So when asked for individual sets, the AI called `lift_history` and got nothing useful. The description now states it returns per-exercise aggregates and routes per-set questions to `whoop_lift_exercise`, which already returns every set (reps/weight/medal per set) correctly.

### Added

- **`whoop_communities`** (new tool, brings total to 48). Lists the communities you're a member of (teams, friend groups) with member counts and — optionally — your rank in each across a chosen metric (strain/sleep/recovery) over a window (day/week/month). Complements `whoop_leaderboard`: use `whoop_communities` to discover community IDs, then drill into one with `whoop_leaderboard`. Source: `GET /community-service/v1/communities/memberships` (already in use by `whoop_leaderboard` for community auto-discovery). Schema is permissive at the record level since the per-record field set hasn't been captured against a live account at the time of release — a `WhoopProjectionError` from this tool is the signal that Whoop's actual shape differs from the inferred one and the projection needs tightening.
- **Strain target** added to `whoop_strain` output. The existing deep-dive response carries `score_target`, `lower_optimal_percentage`, and `higher_optimal_percentage` as 0–1 fractions of max strain (21); the projection multiplies by 21 to expose them as strain values. New schema field: `target: {value, optimal_lower, optimal_upper}`. Lets the AI answer "should I work out today?" with a concrete number ("you're at 18.9, target was 13.2 — already past optimal") instead of just a state label.

### Added (earlier in this cycle)

- **README banner.** New SVG banner at the top of the README (`assets/banner.svg`) — figlet-style "WHOOP MCP" block text in light gray with a 5-beat EKG pulse waveform underneath (real `<path>` element, not ASCII), centered horizontally, theme-aware via `prefers-color-scheme` (auto-flips to light text on dark mode). Added `assets/` to `package.json` `files` whitelist so it ships with the published package.

### Fixed

- **Timestamps returned in user's local timezone.** Whoop's API returns every timestamp in UTC (`2026-05-25T22:30:00Z`), which confused the AI on the consumer side — `22:30:00` got interpreted as a clock time when it's really 3:30 PM in San Jose. The MCP now rewrites every UTC timestamp in tool responses with an explicit local offset (`2026-05-25T15:30:00-07:00`) — same instant, but the AI sees the actual local clock value. Implementation: single helper in `src/lib/timezone.ts`, applied in `jsonOut()` so every tool gets the conversion for free.

  Three-tier resolution chain so OSS users on any host get sensible timestamps without manual config:
  1. **`WHOOP_TIMEZONE` env var** (IANA name like `America/Los_Angeles`) — explicit override.
  2. **Auto-detected from Whoop profile.** On server boot, the MCP fetches `/users-service/v2/bootstrap` and caches the user's `timezone_offset` (e.g., `-0700`). Refreshes hourly so travelers get auto-updates without restarting. Fire-and-forget — server startup doesn't block on the fetch.
  3. **System TZ** — last resort. UTC on Fly/Railway/Docker, so Tier 2 saves you here.

  Tier 2 means `WHOOP_TIMEZONE` is now **optional** for nearly all users — local installs use system TZ, deployed installs use the Whoop-profile fallback automatically. `toLocalIso()` handles both IANA names (`America/Los_Angeles`) and fixed offsets (`-0700`, `-07:00`) since Whoop's API returns the offset form. 25 unit tests covering DST transitions, positive/negative/half-hour offsets, date rollover, millisecond precision, the priority chain, and pass-through for date-only / non-ISO strings.
- **Claude Desktop config for remote MCP.** Docs (README → Remote hosting) and the `whoop-mcp config http` CLI command previously emitted the `{"url": "...", "headers": {...}}` format for Claude Desktop, which Claude Desktop rejects with *"The following entries in claude_desktop_config.json are not valid MCP server configurations and were skipped"*. That format only works for **Claude Code** (which natively supports remote MCP). Claude Desktop only speaks stdio, so the docs + CLI now emit a stdio bridge config using [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) — a small Node package that proxies HTTP MCP servers as stdio. First run downloads via `npx` (~5s), subsequent runs are cached.

### Added

- **`whoop-mcp` CLI.** New first-class command (single binary, installable via `npm link` or, once published, `npm install -g whoop-mcp`) that wraps every npm script plus operational helpers. Works from any directory — the CLI resolves its own install root from `import.meta.url`, so `whoop-mcp deploy` from `~/Desktop` does the same thing as `cd whoop-mcp && fly deploy`.
- 15 subcommands across 5 groups:
  - **Local**: `start [--http]`, `dev`, `dev:http`, `build`, `test`, `typecheck`
  - **Setup**: `bootstrap`, `rebootstrap`
  - **Deployed**: `deploy`, `logs`, `status`, `ping`
  - **Inspect**: `info`, `tools`, `config <stdio|http>`
  - **Help**: `help`, `version` (+ `--help`, `-h`, `--version`, `-v` aliases)
- ANSI 24-bit truecolor banner with the Whoop pulse waveform (honors `NO_COLOR`, skipped on non-TTY stdout).
- `whoop-mcp start` keeps stdout clean (no banner, no header) so it works as a drop-in for `node dist/server.js` in Claude Desktop stdio configs.
- `whoop-mcp ping` and `whoop-mcp status` hit the deployed `/health` endpoint live — instant "is my deploy alive" check.
- `whoop-mcp config http` and `whoop-mcp config stdio` print pre-filled Claude Desktop config snippets with absolute paths or your detected Fly URL.

### Changed

- `package.json` → `bin.whoop-mcp` now points at `./dist/cli/index.js` (was `./dist/server.js`). The MCP server is still bootable via `whoop-mcp start` — this is a CLI surface change, not a server change. Anyone with a Claude Desktop config invoking `whoop-mcp` directly (none of the published quickstarts did this) should switch to `whoop-mcp start` or stay on `node dist/server.js`.
- `npm run rebootstrap` — wrapper script that combines `npm run cognito-bootstrap` (interactive SMS code prompt) with `fly secrets set` so re-bootstrapping a deployed instance is a single command from your Mac. Auto-detects the Fly app name from `fly.toml`, `$FLY_APP`, or `--app <name>`. Solves the ~30-day refresh-token expiry problem for remote deployments.
- Troubleshooting + README → Remote hosting now document the recovery flow: when Cognito tokens hit their 30-day wall, you run `npm run rebootstrap` (or `whoop-mcp rebootstrap`), type the SMS code in your terminal, the new tokens get pushed to Fly automatically (~10s restart).

### Known limitation

- The rebootstrap flow still requires you to be at a Mac (or any machine with the repo + `fly` CLI installed). If you're traveling when refresh dies, you're locked out. A future feature would add a `/admin` web route accepting the SMS code from a browser, callable from a phone.

## [1.1.0] — 2026-05-26

### Added

- **Remote hosting via HTTP transport.** The MCP now supports two transport modes:
  - `MCP_TRANSPORT=stdio` (default) — current local Claude Desktop / Claude Code behavior
  - `MCP_TRANSPORT=http` — boots a Streamable HTTP server at `/mcp` behind a bearer-token gate, suitable for deployment to Fly.io, Railway, Render, a VPS, or any Docker host
  - Static bearer-token auth via `MCP_AUTH_TOKEN` env var (generate with `openssl rand -hex 32`). Constant-time compare to dodge timing attacks. Returns 401 on missing or wrong token without leaking which.
  - Health probe at `GET /health` (no auth).
  - CORS pre-configured for browser-based MCP clients.
- **`Dockerfile`** — multi-stage Alpine build, ~150 MB, runs as the non-root `node` user, ships a `HEALTHCHECK` directive. Deploy anywhere that runs containers.
- **`TokenStore` abstraction** (`src/whoop/token_store.ts`) — `EnvFileTokenStore` (default, writes refreshed tokens back to `.env`) and `MemoryTokenStore` (for read-only filesystems like Cloudflare Workers). Selectable via `WHOOP_TOKEN_STORE` env var. The Dockerfile uses `memory` by default; mount a writable volume + set `envfile` if you want persistence across restarts.
- **New npm scripts**: `dev:http` and `start:http` for running locally in HTTP mode.
- **9 HTTP-auth unit tests** in `tests/whoop/http_auth.test.ts` covering: 401 with no header / wrong token / wrong-length token (timing-safe path), 400 malformed body, 200 `/health` (no auth), 404 unknown path, 204 OPTIONS preflight with CORS headers, refuses to start with missing or too-short auth token.
- **New README section: "Remote hosting"** — full walkthrough including the Docker-based deploy path, instructions for Fly / Railway / Render / VPS / Cloudflare Tunnel, AI-client config snippets for both Claude Desktop and Claude Code with the bearer header, environment-variable reference, and a security model section.

### Changed

- `TokenManager` constructor now takes either `{ store: TokenStore }` or `{ envPath: string }` (the latter is shorthand for `new EnvFileTokenStore(envPath)`). Existing local stdio behavior is unchanged.
- Server version bumped to 1.1.0 in both `package.json` and the `McpServer` constructor.

### Migration

The default `MCP_TRANSPORT=stdio` means existing local installs are unaffected. To move to HTTP, follow the new [Remote hosting](README.md#remote-hosting) walkthrough.

## [1.0.0] — 2026-05-26

Initial public release.

### Added

- **48 MCP tools** wrapping Whoop's private iOS API:
  - 31 reads (today, day, profile, calendar, recovery, sleep, strain, trend, compare, stress, sleep_need, live_hr, live_state, live_stress, workouts, workout, sports_catalog, lift_prs, lift_exercise, lift_progression, lift_history, lift_library, lift_catalog, journal, journal_catalog, behavior_impact, cycle, performance_assessment, smart_alarm, leaderboard, hr_zones)
  - 14 writes (activity_create, activity_delete, lift_log, lift_template_save, lift_custom_exercise, journal_log, journal_autopop, cycle_log, symptom_log, smart_alarm_set, hr_zones_set, profile_update, hidden_metric, coach_ask)
  - 2 escape hatches (raw, endpoints)
- **4 bundled catalogs** generated from live API: 372 official Strength Trainer exercises, 308 journal behaviors, 203 sport_id mappings, 384 deduped iOS endpoint paths.
- **Session-scoped catalog gate** in `src/whoop/session_state.ts`. Tools that take exercise / behavior / sport IDs refuse to run until the corresponding lookup tool has been called once per session. Keeps ~14k tokens out of the system prompt.
- **Write-safety harness**: every write tool defaults `confirm: false`, returning a preview of what would be sent. AI must explicitly re-call with `confirm: true` to fire.
- **AWS Cognito auth** via Whoop's `/auth-service/v3/whoop/` proxy. No AWS SDK, no client secret extraction. Supports SMS MFA + TOTP. Auto-refresh on 401 with single-flight gate; persists refreshed tokens to `.env`.
- **Structured zod-validated outputs**. Every tool's response goes through a per-tool schema before returning to the client — catches Whoop API drift instead of silently returning malformed data.
- **TypeScript 6 strict** with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. Node 24+.
- **116 unit tests** (vitest, fixture-driven projection tests).
- **MIT license** with Whoop trademark disclaimer.

### Documentation

- [`README.md`](README.md) — full developer-grade documentation: setup, every tool's signature + endpoints + caveats, architecture, schema design, write-safety details, token usage analysis, FAQ, troubleshooting.
- [`WHOOP_API_ENDPOINTS.md`](WHOOP_API_ENDPOINTS.md) — 5,900-line reverse-engineering writeup: methodology, every microservice, every endpoint, every body shape, every enum, every status code pattern, auth flows, capture sessions, the dedup pipeline.

### Known limitations

- **Reverse-engineered.** Whoop can change response shapes any time; when they do, projections may need updating. The zod schemas surface drift as `WhoopProjectionError` rather than silent corruption — see [Fixing a broken projection](README.md#fixing-a-broken-projection) for the recovery loop.
- **Avatar upload** is not wrapped (requires multipart upload with raw PNG bytes).
- **Webhooks** (Whoop's push-notification surface for sleep/workout/recovery events) are not exposed by the MCP. The OAuth API has 6 webhook events; we don't currently subscribe.
- **Per-set strength detail** (set 1: 10 reps @ 200lbs, set 2: ...) is not available in `/cardio-details`. `whoop_lift_history` returns per-exercise aggregates (set count, total reps, tonnage, medals). For per-set numbers across all your workouts of a specific exercise, use `whoop_lift_exercise`.
- **`whoop_cycle`** requires the user's MCI (menstrual cycle insights) survey to be completed. Fresh accounts return 400 until they set `contraception_type`.

### Pre-1.0 milestones (in the testing repo)

The v1 codebase (a thinner raw-passthrough version with no projections or write-safety harness) is archived at `../whoop-testing/v1/` for reference.

Reverse-engineering happened across three mitm capture sessions in May 2026:
- **Phase 1** (2026-05-23): primary account, read-heavy session, 122 MB capture
- **Phase 8a** (2026-05-24): test account onboarding, 29 MB
- **Phase 8b** (2026-05-24): test account write surface, 284 MB
