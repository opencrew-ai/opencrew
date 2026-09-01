# Contributing to OpenCrew

Thanks for wanting to make the crew better. This is a young codebase moving fast — small,
focused PRs land quickest.

## Local development

**Prerequisites:** Node 20+, pnpm, and [Claude Code](https://claude.com/claude-code) installed
and logged in (agents run as Claude Code sessions — no separate API key needed).

```bash
git clone https://github.com/opencrew-ai/opencrew && cd opencrew
pnpm install
pnpm dev        # web on :5173, server on :3001
```

Sign in with the seeded admin (`admin@opencrew.local` / `opencrew`). The database is embedded
Postgres (PGlite) at `data/opencrew.pgdata` — delete `data/` and run `pnpm seed` for a clean
slate.

```bash
pnpm test       # all tests (Vitest) — fabric kernel, guardrails, task DAG, diffs
pnpm build      # typecheck + build every package
```

CI runs exactly these on every PR, plus a Lighthouse pass on the marketing site.

## Before you build

- **Bugs and small fixes** — go straight to a PR.
- **New features or architecture changes** — open an issue first to align on the approach.
  For anything touching coordination (scheduling, approvals, retries), read
  [DESIGN.md](DESIGN.md) first; the invariants there (crash-only, level-triggered, the DB is
  the only truth) are load-bearing.
- **New agent tools** are the easiest high-value contribution — one file under
  `apps/server/src/tools/`, see the "Adding a tool" section in the README.

## Ground rules for changes

- **Guardrails are sacred.** Anything that lets an agent act must pass through the existing
  choke points (the `PreToolUse` gate, `canPostInChannels` at message creation, approval
  cards). PRs that route around them won't merge, however cool the feature.
- **Tests ship with behavior.** New coordination behavior needs a test in
  `apps/server/src/__tests__/`; the suite must stay green.
- **No secrets in the repo.** Ever. `.env` is gitignored for a reason.
- Match the style around you — the codebase favors small files, early returns, and comments
  that explain *why*, not *what*.

## Commit and PR format

Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`.

PRs: describe what changed and why, list how you tested it, and keep unrelated changes out.
If the PR changes UX, a screenshot or short recording helps a lot.

## Questions

[Discord](https://discord.gg/DSpbp4Fn7e) is the fastest place to ask. Issues work too.
