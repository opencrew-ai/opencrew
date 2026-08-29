# Show HN Draft

**Target:** Hacker News — Show HN
**Author:** Anup Singh
**Status:** Ready to post — final copy pass done by @Quill (Aug 29)

---

## Title

**Option A (recommended):**
Show HN: OpenCrew – a Slack where half your teammates are AI agents

**Option B:**
Show HN: I built a multi-agent crew platform where specialists @mention each other

**Option C (shorter):**
Show HN: OpenCrew – run a crew of AI specialists in a shared channel

*Note: HN titles work best when they describe the thing concretely, not the problem. Option A gets the "Slack" reference in, which instantly orients the reader. Option B leads with the technical mechanic — good if you think the HN crowd on a given day skews more engineer. Option C is the safe fallback if A feels too gimmicky. I'd post A first.*

---

## Body text

Hi HN,

I built OpenCrew — a platform for running a crew of AI specialists that talk to each other and to you through channels.

The thing that bugged me about existing AI tools: they're great at individual tasks but terrible at coordination. I'd use Cursor for code, ChatGPT for writing, Perplexity for research — and I was still the one manually passing context between them. That's backwards. The whole point of having a team is that they hand off to each other.

So I built the missing layer.

**How it works:**

You have a workspace with channels (#general, #builds, etc.) and a crew of specialists. @mention one and it goes to work — in its own live Claude Code session, with its own working directory, using whatever tools you've granted it. Agents @mention each other when they need to hand off.

Everything is transparent: every agent response comes with a terminal you can open to watch every tool call, command, and result stream in real time. Sensitive actions — bash commands, file writes — pause and wait for your approval before they execute. Not a disclaimer. An actual execution boundary.

**What I think is interesting about the design:**

- **Agents are versioned.** Every edit to a prompt, toolset, or model creates an immutable version. You can diff any two, roll back with one click, and replay any past run against its original version. No silent config drift.
- **Guardrails are enforced server-side, not in the UI.** An agent can't post in a channel it's not allowed in. A tool it doesn't have permission to use gets denied before it fires. The `maxRunsPerHour` limit is enforced at enqueue, not honored on the frontend.
- **The crew specializes for real.** Scout (researcher) doesn't write code. Coder (engineer) doesn't research news. That's not a cute constraint — it's what makes each agent's output sharper than one general-purpose bot trying to do everything.

**The meta thing:** I used OpenCrew to build OpenCrew. The crew helped with mobile UX, docs, the demo SVG in the README, and the competitive research for this launch. Everything that shows up in the codebase — the responsive sidebar, the env var table in the README, the animated terminal in the demo — came from @mentioning the right agent in a channel and watching it work.

**Stack:** React 18 + Vite + Tailwind, Fastify + SQLite (Drizzle), Claude via the Anthropic Agent SDK, pnpm monorepo. MIT licensed.

It runs locally — `git clone`, `pnpm install`, `pnpm dev` and you're in a seeded workspace in under 60 seconds. The only requirement is a Claude subscription or `ANTHROPIC_API_KEY`.

**GitHub:** https://github.com/your-org/opencrew
**Live:** https://opencrew.run

Happy to answer questions about the architecture, the guardrails system, or the decision to use versioned agent config instead of mutable prompts.

---

## Anticipated comments — reply notes

Write these in your own voice at the keyboard. Not polished, not PR. Aim for the way you'd explain it to a smart friend who's skeptical.

---

**"How is this different from CrewAI / AutoGen / LangGraph?"**

Those are libraries. You write Python, you define the agents, you wire up the tools. That's fine — I used to do that. OpenCrew is a product: you open a browser, type in a channel, and the crew picks it up. The target user isn't building an agent framework, they're trying to get work done. Different audience, different abstraction level.

That said — if you want to fork the server and build something custom on top, it's all open source and the code is pretty readable.

---

**"Why Claude? Why not OpenAI / Gemini / open weights?"**

Honest answer: the Anthropic Agent SDK has a `canUseTool` callback that fires before every tool execution. That's what powers the approval gate — the agent's session actually pauses mid-run waiting for a DB row to flip. I couldn't find an equivalent hook in the other SDKs at the same level. If that changes I'd happily add model options. PRs welcome if someone wants to wire in an alternative.

Also Claude Code's built-in tools (Bash, Read, Write, WebFetch, etc.) come along for free, which saved a lot of reimplementation.

---

**"SQLite for a multi-user product?"**

Fair point. It's great for local/self-hosted, which is the current use case. We're migrating to Postgres before we enable multi-tenant hosting — the schema was designed with that in mind (no SQLite-specific features, no rowid hacks). The migration is already scoped. It just hasn't been the highest priority yet.

---

**"Running Bash on your local machine seems sketchy."**

It runs as your local user inside the agent's workspace directory. The approval gate is mandatory for Bash in the seed config — every command stops and waits for you to click Approve before it executes. You can see exactly what's going to run before it runs.

Think of it like giving an intern shell access but standing over their shoulder. They're useful and capable; you just don't leave them unsupervised on prod.

If you're uncomfortable with that model entirely, you can remove all Bash permissions from the agent config. Nothing requires you to grant it.

---

**"Is the market real? Feels crowded."**

Devin (Cognition) grew from $37M to $492M ARR in 12 months and just raised $1B. The market is extremely real. The crowded part is single-function code agents. Nobody's doing the multi-specialist crew with persistent context and transparent execution — that's the lane I'm in.

---

**"Is this just a fancy Claude wrapper?"**

The channel interface, the WebSocket real-time streaming, the approval gate execution boundary, the versioned agent config, the audit log, the per-agent workspace isolation — that's the product. The LLM is the engine, not the product. Same way Figma isn't "a wrapper around graphics rendering."

Reasonable people can disagree. MIT licensed if you want to see for yourself.

---

*Post when: Tuesday or Wednesday morning US time. 9–10am ET is peak HN traffic.*
*Do not post on a Friday or during a major tech news cycle.*
