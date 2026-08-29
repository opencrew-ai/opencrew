# OpenCrew Build Plan

Weekend MVP. Humans + AI agents in the same channels, with guardrails and version control.

## Architecture pivot (owner decision, day 1)

**Agents run AS Claude Code sessions.** The run engine spawns headless Claude Code
via `@anthropic-ai/claude-agent-sdk` (`query()`), many concurrent sessions in the
local terminal, instead of calling the Anthropic Messages API directly.

- Built-in Claude Code tools replace hand-rolled ones: `WebFetch`/`WebSearch` ≫
  web_fetch, `Bash` ≫ run_code (real shell in a per-agent workspace dir).
- OpenCrew-native tools (`post_to_channel`, future contributions) are served over
  an in-process MCP server — the MCP tool registry IS the plugin system.
- Approval gates use the SDK's `canUseTool` permission callback: a gated tool
  call blocks on a promise until an admin resolves the approval card. This is
  the executor-level choke point the guardrail invariants require.
- Non-gated allowed tools are pre-approved via `allowedTools`; everything else
  hits `canUseTool`, which denies tools outside the version's tool list.
- Auth: the user's local `claude` login (or ANTHROPIC_API_KEY). No key required
  for `pnpm dev` if Claude Code is already authenticated.
- Consequence: an approval wait lives in process memory — a server restart
  fails in-flight runs (incl. awaiting_approval) at boot. Acceptable for MVP.
- **The terminal shows up in the product**: every run streams its session
  activity (`run_steps`) over WS into a live terminal-style panel in the web
  UI — commands, tool calls, outputs, token usage. TODO: real PTY + xterm.js.

## Build order

1. **Scaffold** — pnpm monorepo (`apps/server`, `apps/web`, `packages/shared`), TS config, MIT license.
2. **DB + schema** — SQLite via Drizzle. All core tables. Seed script.
3. **Auth** — email+password, session cookie, signed invite links. First user = admin.
4. **REST + WS core** — Fastify server, channels, messages, threads, presence over WebSocket.
5. **Agents CRUD + versioning** — every edit creates an immutable `agent_versions` row. Diff + rollback endpoints.
6. **Run engine** — in-process job queue. @mention → run → context build (last 30 msgs) → Anthropic Messages API loop with tools → post reply. Runs pinned to `agentVersionId`.
7. **Tools plugin registry** — one file per tool: `web_fetch`, `run_code` (worker thread, 10s timeout), `post_to_channel`.
8. **Guardrails** — enforced in executor: tool allowlist, approval gates (`awaiting_approval` + approval card + resume/abort), `canPostInChannels`, `maxRunsPerHour`. Every action → `run_steps` row.
9. **Web app** — React + Vite + Tailwind, dark mode. Login/invite, channel list, message pane w/ markdown + threads, presence dots, approval cards, agent admin pages (form, version history, diff, rollback).
10. **Tests** — guardrail invariants + version diff logic only (vitest).
11. **README** — 60s quickstart, architecture sketch, "adding a tool" guide.
12. **P1 (if time)** — run inspector drawer, agent→agent mentions (depth ≤2), DMs, `/agents` + `/pause` slash commands.

## Decisions made without asking (noted per instructions)

- **SQLite driver**: `better-sqlite3` (sync, fast, zero-setup). Drizzle schema kept portable to Postgres (text ids, integer timestamps).
- **IDs**: `nanoid` text ids everywhere — portable across SQLite/Postgres.
- **Queue**: simple in-process async loop with a concurrency cap (4). Runs surviving restart: `queued`/`running` runs are marked `failed` on boot (crash-safe, simple). `awaiting_approval` runs survive restarts (state is in DB, resume re-hydrates).
- **Streaming**: agent replies stream token-by-token over WS into a placeholder message, finalized on completion.
- **Sessions**: DB-backed session table + httpOnly cookie (no JWT).
- **Invite links**: HMAC-signed token with expiry, secret auto-generated into `.env` on first boot if missing.
- **`run_code`**: TS via worker thread; transpile with esbuild-wasm? No — keep simple: run as plain JS/TS via `node:worker_threads` with `ts` stripped by a light transform (esbuild transform API, already a Vite dep tree). 10s hard timeout, no fs/net imports blocked (TODO: harden; documented as unsafe-by-default, gate behind approval in seed).
- **Approval cards**: rendered as system messages of type `approval` in the channel, resolved via REST, broadcast over WS.
- **Presence**: in-memory map of connected user sockets; agents derive idle/running from active runs.
- **Mentions**: `@AgentName` parsed by exact name match (case-insensitive) against workspace agents.

## Slice commits

Each numbered step above lands as one or more conventional commits (`feat: …`) with the app in a working state.
