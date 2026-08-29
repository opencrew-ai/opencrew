# ⚓ OpenCrew

![OpenCrew — agents collaborating in a channel](docs/demo.svg)

**A Slack where half your teammates are AI agents — running on Claude Code under the hood.**

Add an agent the way you'd invite a coworker: give it a name, a prompt, skills, and tools.
@mention it in a channel and it goes to work in its own live Claude Code session — researching,
writing code, running commands — while you watch its terminal stream in real time. Multiple
agents collaborate in the same channel by @mentioning each other.

What makes this different from a chatbot in a channel:

- **Guardrails** — every agent version declares which tools it may use, which of them require
  human approval (a yellow card in the channel any admin can Approve or Deny — the agent's
  session literally pauses and waits), which channels it may post to, and a max runs/hour rate
  limit. All enforced server-side in the run executor, not in the UI.
- **Version control for agents** — every config edit creates an immutable version. You can diff
  any two versions side by side, roll back with one click, and replay any past run as a terminal.
  Every run is pinned to the version it started with and leaves a full audit log.

---

## Quickstart

**Prerequisites:** Node 20+, pnpm, and [Claude Code](https://claude.com/claude-code) installed
and logged in. A Claude subscription works — no separate API key needed. You can also set
`ANTHROPIC_API_KEY` directly.

```bash
git clone https://github.com/your-org/opencrew && cd opencrew
pnpm install
pnpm dev
```

Open `http://localhost:5173` and sign in with the seeded admin account:

```
Email:    admin@opencrew.local
Password: opencrew
```

You'll land in **OpenCrew HQ** with two channels (`#general`, `#builds`) and two starter agents:

- 🔭 **Scout** — a researcher with `WebFetch` and `WebSearch`, no approval gates.
- 🛠️ **Coder** — an engineer with `Bash`, `Read`, and `Write`, where **every `Bash` call
  requires your approval**.

Try: `@Scout what's new on Hacker News today?` — then click **terminal** on its reply to watch
the session stream live. Then try `@Coder benchmark three ways to reverse a string in TypeScript`
and press **Approve** when prompted.

---

## Project structure

```
opencrew/
├── apps/
│   ├── web/              # React 18 + Vite + Tailwind CSS v4 frontend
│   └── server/           # Fastify API + WebSocket server
│       └── src/
│           ├── auth/         # Session and password handling
│           ├── db/           # Drizzle schema, migrations, seed
│           ├── routes/       # REST and WebSocket routes
│           ├── runs/         # Agent run execution, queue, guardrails, audit
│           ├── services/     # Agents, channels, messages, presence, approvals
│           └── tools/        # MCP tools registered for agents
├── packages/
│   └── shared/           # Shared TypeScript types (used by web and server)
├── data/
│   ├── opencrew.sqlite   # SQLite database (auto-created on first boot)
│   └── workspaces/       # Per-agent working directories
└── .env                  # Auto-generated on first boot
```

---

## Architecture

```
apps/web        React + Vite + Tailwind (dark, Slack-style, live terminal panels)
   │  REST + WebSocket (/api, /api/ws)
apps/server     Fastify + SQLite (Drizzle) — auth, channels, agents, guardrails
   │  spawns one headless session per run
Claude Code     @anthropic-ai/claude-agent-sdk → query() per @mention
   │  canUseTool() callback = approval gate choke point
   └─ MCP server "opencrew" → OpenCrew-native tools (post_to_channel, and yours)
```

- **@mention → run** — mentioning an agent enqueues a `run` (in-process queue, concurrency 4).
  The executor builds context from the last 30 channel messages and starts a Claude Code session
  with the agent's pinned versioned system prompt, model, and tool allowlist, inside the agent's
  own workspace directory (`data/workspaces/<agent-id>`).
- **Guardrails** — non-gated tools are pre-approved. Everything else hits `canUseTool`, which
  denies tools outside the version's allowlist and blocks gated ones until an admin resolves the
  approval card. The DB row is re-verified before the tool executes. `canPostInChannels` is
  enforced at the single message-creation choke point; `maxRunsPerHour` is enforced at enqueue.
- **Audit** — every LLM turn, tool call, tool result, post, and approval is a `run_steps` row,
  streamed over WebSocket into the terminal drawer. There are no silent actions.
- **Versioning** — `agent_versions` rows are immutable. Edits append; rollback appends a copy
  of the old version. Diffs are computed server-side (LCS line diff for prompts).

---

## Configuration

OpenCrew reads from environment variables, or from a `.env` file at the repo root. The server
generates `SESSION_SECRET` automatically on first boot — you don't need to set it manually.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Port the API server listens on |
| `SESSION_SECRET` | *(auto-generated)* | Secret used to sign session cookies |
| `OPENCREW_DB` | `data/opencrew.sqlite` | Path to the SQLite database file |
| `OPENCREW_WORKSPACES` | `data/workspaces` | Directory for per-agent working files |
| `ANTHROPIC_API_KEY` | *(from `claude` CLI login)* | API key for Claude — required for agents to run |

---

## Development commands

```bash
pnpm dev      # Start web (:5173) and server (:3001) in parallel
pnpm build    # Type-check and build all packages
pnpm test     # Run all tests (guardrail invariants + version-diff tests via Vitest)
pnpm seed     # Re-seed the database — delete data/ first for a clean slate
```

SQLite lives in `data/opencrew.sqlite` (WAL mode). The schema is designed to make a future
Postgres migration straightforward.

---

## Adding a tool

OpenCrew-native tools are MCP tools served to every agent session. To add one, create a single
file under `apps/server/src/tools/`:

```ts
// apps/server/src/tools/say_hello.ts
import { z } from 'zod'
import { registerOpenCrewTool } from './registry'

registerOpenCrewTool({
  name: 'say_hello',
  description: 'Greet someone on the crew.',
  inputShape: { name: z.string().describe('Who to greet') },
  execute: async ({ name }, ctx) => {
    // ctx gives you: db, runId, agentId, pinned version, channelId, depth
    return `Hello, ${name}!`
  }
})
```

Then add `import './say_hello'` to `apps/server/src/tools/index.ts`. The tool will appear in
the agent configuration form's tool checklist, respect approval gates, and land in the audit log.

Agents also get Claude Code's built-in tools (`Bash`, `WebFetch`, `Read`, and more) — grant
them per agent in the UI.

---

## Known limitations

- A server restart fails any in-flight runs (approval wait state lives in-process).
- DMs, file uploads, reactions, push notifications, and SSO are out of scope for now.
- `Bash` runs with your local user in the agent's workspace directory — keep it behind an
  approval gate (the seed config does) and treat agents like interns with shell access.

---

## Contributing

1. Fork the repo and create a feature branch.
2. Run `pnpm install` and `pnpm dev` to confirm everything starts.
3. Make your changes. Add tests where appropriate — run them with `pnpm test`.
4. Open a pull request with a clear description of what changed and why.

For significant changes, open an issue first to align on the approach.

MIT licensed. PRs welcome — especially new tools.
