<p align="center">
  <img src="docs/logo.svg" width="84" alt="OpenCrew" />
</p>
<h1 align="center">OpenCrew</h1>
<p align="center"><b>Give your Claude subscription a team.</b></p>

<p align="center">
OpenCrew turns your <a href="https://claude.com/claude-code">Claude Code</a> subscription into a
local, reviewable team of AI agents. One ask becomes a crew workflow you can watch: a Captain
delegates, workers build in their own checkouts, reviewers vet, you approve. Every approval
is a commit in your repo.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#ten-minutes-one-outcome">Ten minutes</a> ·
  <a href="#why-not-just-more-terminals">Why not more terminals?</a> ·
  <a href="docs/GUIDE.md">In depth</a> ·
  <a href="https://discord.gg/DSpbp4Fn7e">Discord</a> ·
  <a href="https://opencrew.run">opencrew.run</a>
</p>

![OpenCrew in 25 seconds: the ask, the Captain spawning a worker, the worker checking its change in your real Chrome, the review, one click to approve, and the commit](docs/demo.gif)

**Who it's for.** Developers already on Claude Code who want parallel work without babysitting
three terminals. **What changes.** One message becomes a visible workflow with names, threads,
diffs, and a decision. **Why it's safe.** It runs on your laptop on the plan you already have,
no API key. Gated tools stop at an approval card. Agents never `git commit`. What you approve
lands in your repo, so the record is yours, not ours.

## Ten minutes, one outcome

This is the run in the GIF above, typed into a project's `#general`:

> Add a dark mode toggle to the Settings page. Spawn a frontend worker to build it and a qa
> worker to verify it in Chrome before it is proposed. Keep it small.

What happened, unedited: the Captain spawned `frontend-1` in its own checkout of the repo. It
built the toggle, started the dev server on its reserved port, opened the page in the user's
own Chrome, clicked the toggle, reloaded to confirm it persisted, and proposed the change.
CodeReviewer read the diff and cleared it. One click on **Approve & commit** made commit
`ca3b5df` in the repo, with the decision logged in `.opencrew/decisions.md`. Ask to approve:
under four minutes, about $0.90 of the subscription's usage.

## Quickstart

Prerequisites: macOS or Linux, a Claude subscription with the `claude` CLI logged in (the
script installs Node 20 and pnpm if missing), and about two minutes.

```bash
curl -fsSL https://opencrew.run/install | bash
```

It clones into `~/opencrew`, starts the app on the first free ports, and opens your browser
already signed in. Then:

1. **What are you building?** Name it. Point at its repo, or leave it empty and OpenCrew keeps a
   repo for it.
2. **Just type** in the project's `#general`. The Captain 🧭 reads every message and spawns
   workers (`frontend-1`, `qa-1`, …) for real work. Click **terminal** on any reply to watch.
3. **Needs You** fills up as work comes back, already reviewed by the built-in 📚 Librarian and
   🔍 CodeReviewer. One click approves, and the approval is a commit.

Something off? **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** covers the five things
that go wrong in the first ten minutes. Re-run the install line to update; remove it with
`… | bash -s -- --uninstall`. Codespaces and manual install are in
[docs/GUIDE.md](docs/GUIDE.md#other-ways-to-run-it).

## Three things people use it for

- **Explore a codebase before a feature.** "Three attempts at the checkout refactor, pick the
  best." Three workers, three checkouts, one CodeReviewer verdict, one diff in your inbox.
- **Review a PR with specialists.** Security to one worker, test coverage to another, a
  consolidated proposal from the Captain. Nothing merges until you say so.
- **Turn a vague ask into a plan.** "What would you build first here?" A researcher digs, the
  Captain proposes a plan doc, the Librarian checks it isn't a duplicate, you approve, and the
  tasks land on a board the crew works top-down.

## Your repo is the memory

OpenCrew keeps no agent memory of its own. What the crew proposes and you approve becomes
files and commits in your repo:

```
.opencrew/
  plans/…, notes/…     docs the crew proposed and you approved, one file each
  decisions.md         one line per approval, rejection, or change request
```

The review thread rides along as a git note. After a real run, in a plain terminal:

```
$ git log --notes=opencrew -1
b05ebb2 docs: Shop Launch Checklist (v1)
Notes (opencrew):
    OpenCrew review · "Shop Launch Checklist" v1 (plan)
    Proposed by agent Captain; approved by anup-singhai.
    Review comments:
    - anup-singhai: Good. Keep step three about the announcement.
```

Agents read the same files you do. Push the repo (`git push origin main refs/notes/opencrew`)
and the memory goes with it. Ask a project's Captain *"what did we decide about the launch?"*
and the answer cites `path@sha`. Leave OpenCrew any time; the record stays.

## Why not just more terminals?

| | Three Claude Code tabs | OpenCrew |
|---|---|---|
| Who coordinates | You, from memory | A Captain per project; workers report in threads |
| What you see | Three scrollbacks | Rooms, live terminals, diffs, one inbox |
| Same repo, same time | Edits collide | Each worker has its own worktree and port |
| Risky commands | Whatever the tab does | Stop at a card; approve from your phone |
| What survives | Nothing | Every approval is a commit; the review is a git note |
| Where it runs | Your laptop | Your laptop, same subscription, no API key |

**When not to use it:** a one-shot task you'd finish in one prompt; a repo you can't let
anyone commit to; a team with no approval habit yet. What's still early: no mid-turn steering,
no DMs or push notifications, Linux and macOS only. The rest of the rough edges are in
[docs/GUIDE.md](docs/GUIDE.md#known-limitations).

## Use it from anywhere

Agents and repos stay on your machine. In **⚙ Settings**, link the crew to
[opencrew.run](https://opencrew.run) and open the same app from your phone or any device;
sign in once. Prefer your own front door? A Cloudflare tunnel works too
(`OPENCREW_TUNNEL_TOKEN` and `OPENCREW_TUNNEL_URL`, see [docs/GUIDE.md](docs/GUIDE.md)).

## Pricing

**Everything on your laptop is free, forever.** No seat limit, no agent limit, nothing local
is ever gated, and the record in your repo is yours whether you pay or leave.

**Pro is the one thing the laptop cannot do alone: decide from anywhere.** When your crew
finishes something while you are away, you open the same app on your phone through
opencrew.run and press approve; your laptop makes the commit. That press is a *remote
decision* (approve, reject, send back, answer a tool approval).

| | Free | Pro · $19/month |
|---|---|---|
| Everything on the laptop | ✓ | ✓ |
| Remote decisions via opencrew.run | 3 a month | Unlimited |
| Teammates with their own login | | ✓ |
| Share a change with someone who has no install | | ✓ |

Self-host the relay and there is no plan at all. Why the line is here:
[Free on your laptop, Pro in your pocket](docs/blog/2026-09-18-free-on-your-laptop-pro-in-your-pocket.md).

## Configuration

Environment variables or a `.env` at the repo root. Everything has a working default.

| Variable | Default | What it does |
|---|---|---|
| `PORT` / `OPENCREW_WEB_PORT` | `3001` / `5173` | API and web ports |
| `DATABASE_URL` | `data/opencrew.pgdata` | Embedded PGlite path, or a Postgres URL |
| `OPENCREW_REPOS` | `data/repos` | Repos OpenCrew keeps itself (folderless projects, HQ) |
| `OPENCREW_ENVS` | `data/envs` | Per-agent worktrees of project repos |
| `OPENCREW_CONCURRENCY` | `8` | Concurrent agent turns (2 reserved for you) |
| `OPENCREW_LOCAL_AUTOLOGIN` | `1` | Browser on this machine is signed in; `0` requires the form |
| `OPENCREW_TELEMETRY` | `1` | Anonymous daily ping: counts and versions only, never content ([source](apps/server/src/services/telemetry.ts)). `0` turns it off; also a toggle in Settings |
| `OPENCREW_RELAY_URL` | `https://relay.opencrew.run` | Cloud Link relay, self-hostable |
| `ANTHROPIC_API_KEY` | *(from `claude` login)* | Only if you'd rather not use the subscription |

More in [apps/server/src/env.ts](apps/server/src/env.ts).

## Development

```bash
pnpm dev      # web :5173 + server :3001, server hot-reload
pnpm test     # Vitest: fabric, guardrails, record, ask, environments…
pnpm build    # type-check and build everything
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the ground rules (the guardrail choke points are
sacred); [docs/GUIDE.md](docs/GUIDE.md) shows how to add a tool in one file. Did your crew do
something worth showing? Open a [Share your workflow](../../issues/new?template=share-your-workflow.md)
issue; the best ones get featured here. MIT licensed.

If OpenCrew saved you time, star the repo. It helps other Claude Code users find it.
