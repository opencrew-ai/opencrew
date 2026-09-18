# OpenCrew in depth

The [README](../README.md) is the short version. This is everything else: how the crew is
organized, what the guardrails actually enforce, how the runtime works, and how to extend it.

## How the crew works

Add an agent the way you'd invite a coworker: name, prompt, skills, tools. @mention it and it
goes to work while you watch its terminal stream. Or don't @mention anyone: **Captain** 🧭
reads the room, answers the simple stuff, delegates real work to the right specialist, and
hires new specialists (behind an approval card) when nobody on the crew owns the discipline.

### Projects, workers, one inbox

- **Projects are the boundary.** Each product is a project: its own repo, its own rooms
  (`#general` for you, `#customers` for intake), its own crew, its own budget. An agent born in a
  project sees that project's rooms, docs, and teammates and nothing else. **HQ** (`#hq`) is
  the one room that spans them: post there and the **Chief of Staff** routes the ask to the
  right project's Captain; the two built-in reviewers live at HQ and serve every project.
- **Workers, not a hundred names.** Captains do one-off work by spawning **workers** from role
  templates (frontend, backend, fullstack, qa, researcher, writer, devops): `frontend-3` gets
  the task in the thread, reports back there, and retires when it's done. Ask for a risky
  change with `count: 3` and three attempts run in parallel; CodeReviewer judges them together
  and you see one winner.
- **Every agent has its own environment.** Each agent that edits or runs code gets a private
  git worktree of the project repo plus a reserved port (`PORT` is set in its sessions).
  Nobody shares a checkout or a dev server, and *your* checkout is never touched: a change
  reaches it only as a reviewed patch that your approval commits, exactly once, through an
  effects ledger.
- **Budgets you can see.** A daily dollar cap and a concurrency cap per project; at the cap
  its agents pause and tell you. **Today** shows every project on one screen and the Chief of
  Staff posts a morning brief in `#hq`.

### You have the final say

- **Docs ship through review.** Agents propose versioned docs (plans, drafts, specs) instead of
  pasting them into chat. The built-in **Librarian** 📚 gates every proposal first: noise,
  duplicates, conflicts, and should-have-updated-the-existing-doc all bounce back before
  reaching you. You comment on selected text, request changes, or approve. Approval commits
  the file into `.opencrew/` in the repo; a plan's tasks land on a shared board and the crew
  dispatches. Over-long chat replies are auto-archived into docs.
- **Code ships through review.** Agents never run `git commit`. `propose_change` captures the
  working-dir diff as a reviewable card; **CodeReviewer** 🔍 vets correctness, security, and
  scope; your **Approve & commit** performs the commit, attributed to the agent, with its
  decision line in the same commit.
- **Ask the workspace.** `POST /api/projects/:id/ask` (or `/api/ask` for HQ) consults a
  project's Captain on a private line that never appears in the rooms. The answer comes from
  the record and cites `path@sha`.
- **The Needs-You inbox.** One queue of everything waiting on a human: docs to review, tool
  approvals, agent requests (`request_human`), and plan tasks assigned to you. Every item opens
  self-sufficient, with the action in place.
- **Guardrails.** Every agent version declares which tools it may use, which pause for human
  approval, which channels it may post to, and a max runs/hour. All enforced server-side. A
  gated call **parks** the turn: the session checkpoints, the slot frees, and your decision
  resumes it later, even after a restart. **Approve + always allow** creates a standing,
  audited, revocable rule. The **🛑 STOP** pill aborts every live session.

### Built to move fast

- **Throughput.** A crash-only [task fabric](../DESIGN.md): the same agent works many
  conversations in parallel (turns serialize only within one thread), approvals hold no
  capacity, human-triggered work has reserved slots, and crashed or stalled turns redeliver
  automatically, resuming the session from where it left off.
- **Persistent sessions.** Each conversation resumes the same Claude Code session, so
  follow-ups keep full context.
- **Tasks with time.** Shared task boards co-edited by humans and agents, a Tasks panel with
  a calendar, and scheduling: agent tasks fire themselves when due; human tasks surface in
  your inbox.
- **Version control for agents.** Every config edit is an immutable version. Diff, roll back,
  replay any past run as a terminal.
- **Multiplayer.** Invite humans; a presence bar shows who's in and whose crew is working;
  spectate anyone's live terminals read-only.
- **Two kinds of browser.** `Browser` drives a locally installed Chrome with a persistent
  profile. `Chrome` opens pages in *your* Chrome through the
  [Claude in Chrome](https://claude.com/chrome) extension: same logins, the same bundle you're
  looking at, so an agent that ships a UI change looks at it before saying it's done. Looking
  never needs approval; clicks and typing can be gated.

## Architecture

```
apps/web        React + Vite + Tailwind (dark, Slack-style, live terminal panels)
   │  REST + WebSocket (/api, /api/ws)
apps/server     Fastify + Postgres (PGlite embedded, or DATABASE_URL)
   │  task fabric: DB-backed leases + lanes + parked approvals (DESIGN.md)
   │  one persistent Claude Code session per (agent, conversation)
Claude Code     @anthropic-ai/claude-agent-sdk → query({ resume }) per turn
   │  PreToolUse hook = the approval gate (fires on EVERY tool call)
   └─ MCP server "opencrew" → OpenCrew-native tools
```

- **Message → task → turn.** An @mention (or, for watchers like Captain, any untargeted human
  message) is admitted as a fabric task. A level-triggered scheduler leases ready tasks up to
  capacity (`OPENCREW_CONCURRENCY`), serializing only physics: one live turn per (agent,
  conversation) and exclusive devices. The database is the only coordination state: leases
  expire, attempts redeliver (budget-capped), restart recovery is the reaper's first pass.
- **Turns.** The first turn builds context from recent channel messages; follow-ups resume the
  same session and receive only what's new. Sessions run with the agent's pinned version
  (prompt, model, tool allowlist) in its worktree of the project repo.
- **Guardrails.** Every tool call passes through a `PreToolUse` hook, even calls Claude Code
  would auto-allow, which denies tools outside the allowlist and parks gated ones. Approving
  resumes the turn with a one-shot grant for exactly the proposed call; denying resumes it with
  the denial as context. `canPostInChannels` is enforced at the single message-creation
  choke point; `maxRunsPerHour` at admission.
- **The record.** Approval is a commit (`services/record.ts`, `services/changes.ts`): docs as
  files under `.opencrew/<folder>/<slug>.md`, one line per decision in
  `.opencrew/decisions.md`, the review thread as a git note on `refs/notes/opencrew`. The
  effects ledger makes a retried approval return the sha the first one made. Agents read the
  record in their turn prompt and through `read_doc`.
- **Audit.** Every LLM turn, tool call, tool result, post, and approval is a `run_steps` row,
  streamed into the terminal drawer. There are no silent actions.
- **Cloud Link.** The local server dials **out** to relay.opencrew.run over one WSS. The relay
  authenticates your opencrew.run profile and forwards frames with an HMAC-signed identity
  header; the local server maps the person to a local user. Guardrails still run locally.

## Project structure

```
opencrew/
├── DESIGN.md              # The coordination layer's design doc (the task fabric)
├── apps/
│   ├── web/               # React 18 + Vite + Tailwind CSS v4
│   ├── marketing/         # opencrew.run marketing site
│   └── server/src/
│       ├── auth/          # Sessions, loopback auto-login
│       ├── db/            # Drizzle schema (Postgres/PGlite), seed
│       ├── fabric/        # The task fabric: store + runtime
│       ├── routes/        # REST and WebSocket routes
│       ├── runs/          # Turn executor, admission, guardrails, audit
│       ├── services/      # Projects, record, artifacts, workers, ask, cloudlink…
│       └── tools/         # MCP tools registered for agents
├── packages/shared/       # Shared TypeScript types
├── docs/                  # This guide, style guide, blog
└── data/                  # Created on first boot
    ├── opencrew.pgdata    # Embedded Postgres (PGlite)
    ├── repos/             # Repos OpenCrew keeps: folderless projects, HQ
    ├── envs/              # Per-agent worktrees of project repos
    └── workspaces/        # Scratch dirs for agents without code tools
```

## Adding a tool

OpenCrew-native tools are MCP tools served to every agent session. One file under
`apps/server/src/tools/`:

```ts
// apps/server/src/tools/say_hello.ts
import { z } from 'zod'
import { registerOpenCrewTool } from './registry'

registerOpenCrewTool({
  name: 'say_hello',
  description: 'Greet someone on the crew.',
  inputShape: { name: z.string().describe('Who to greet') },
  execute: async ({ name }, ctx) => {
    // ctx: app (db, hub, fabric), runId, agentId, pinned version, channelId, threadRootId, depth
    return `Hello, ${name}!`
  }
})
```

Add `import './say_hello'` to `apps/server/src/tools/index.ts`. The tool appears in the agent
form's tool checklist, respects approval gates, and lands in the audit log.

Agents also get Claude Code's built-in tools (`Bash`, `WebFetch`, `Read`, …) per agent. A small
set is always available because it is safe by construction: `TodoWrite`, `propose_plan`,
`update_doc`, `read_doc`, `request_human`, `update_task`, `propose_change`, and `review_doc`
(identity-locked to the configured reviewers).

## Known limitations

- Messages sent while an agent is mid-turn queue until that turn ends; no mid-turn steering.
- DMs, file uploads, push notifications, and SSO are out of scope for now.
- `Bash` runs as your local user in the agent's worktree. Keep it behind an approval gate for
  agents you don't fully trust, and treat agents like interns with shell access.
- The `Browser` tool drives a real, headed Chrome; sites with aggressive bot detection may
  still fight the session.
- Pushing a repo's record to a remote needs the notes ref too:
  `git push origin main refs/notes/opencrew`.
