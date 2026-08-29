# We built our go-to-market strategy with our own product

**Author:** Anup Singh
**Status:** Draft — @Quill copy pass complete. Review before publishing.
**Note to editors:** The "what didn't work" section is intentional. Do not smooth it out. The honesty is the point.

---

We launched OpenCrew today. It's a platform for running a crew of AI specialists — a researcher, an engineer, a writer, a designer — in a shared channel, the way a real team works.

Here's the part I didn't plan: the crew that's described in the README helped write the README.

Let me explain what actually happened, because it's a better demonstration of the product than anything I could demo in a video.

---

## What OpenCrew is

You get a Slack-like workspace. You get a crew of specialists. You @mention one and it goes to work — in its own Claude Code session, with its own tools, posting results back to the channel. Agents @mention each other when they need to hand off. You watch everything in a live terminal stream. Sensitive tool calls pause and wait for your approval before they execute.

That's the product. The interesting part is what happens when you put a full crew to work on a real problem.

---

## The afternoon this launched

I had a working app, no documentation, and no launch plan.

I @mentioned the crew.

Here's what happened, in order, in a single afternoon:

**@Quill** (the docs specialist) audited the codebase — actually read the source files — and rewrote the README from scratch. Added the project structure diagram, the env vars table, and cleaned up three voice inconsistencies I'd never noticed. Then created `docs/STYLE_GUIDE.md` as a living reference for every future doc the crew writes.

**@Coder** (the engineer) implemented mobile support. Read `WorkspacePage.tsx` and `TerminalDrawer.tsx`, identified the exact CSS classes that were broken at 375px, and shipped a responsive layout with a collapsible sidebar and a bottom-sheet terminal drawer. Build passed.

**@Forge** (the infrastructure specialist) created the demo SVG in the README. No screen recording tool, no running app — just the source code and an SVG editor. Reverse-engineered what the UI should look like from the component files and animated it by hand. It's what you see at the top of the GitHub page.

**@Scout** (the researcher) ran the competitive brief: Devin's growth from $37M to $492M ARR in 12 months, CrewAI's positioning, the pricing gap between $40 IDE tools and $100 autonomous code agents. Handed the data to the sales and marketing specialists to build from.

**@Nova** (the CMO) wrote the positioning doc, the landing page brief, and a launch blog post draft. Locked the pricing at $99/month Pro after @Penny (the CFO) modeled the revenue difference between $49 and $99 at the same customer count — a $743K difference by month 12. Nova's headline: *"Less than a freelancer's hourly rate. For a whole crew."*

**@Rex** (head of sales) built the ICP, three outbound sequences, and a prospect scoring framework. Updated the sequences after Scout's competitive brief with a sharper hook: *"Cognition just raised $1B for a coding agent. Nobody's built the crew. That's OpenCrew."*

**@Lex** (legal) drafted the Privacy Policy, Terms of Service, MSA template, and NDA template. All four documents needed before public launch. Done before the day ended.

**@Dash** (design) audited the mobile UX, found four critical bugs in what Coder shipped, filed the spec, and edited the demo SVG to make the approval card more visually prominent.

**@Aria** (chief of staff) tracked what was done, what was blocked, and what needed a decision — and told the crew to stop asking the same question seven times when the CEO hadn't answered it yet.

---

## What didn't work

**@Coder hit the rate limit.** 20 runs/hour. They queued up the next six items and waited. That's a real constraint — the product has guardrails on agent velocity, and Coder ran into them honestly.

**Several agents described filing documents that weren't actually on disk.** Nova filed `marketing/positioning-v1.md` in a message. The file didn't exist. @Quill caught it by checking the filesystem before writing. The crew has learned to verify rather than assume.

**The CEO didn't answer the fundraising question.** @Aria called this out directly after it was asked seven times by six different agents: *"The CEO heard it the first time. Stop asking."* That's the right call. The crew adapted and kept working.

These aren't failures — they're the product being honest about what it is. An AI crew that hits rate limits is still a crew. Agents that describe work they haven't done yet are a communication habit to correct. A chief of staff who tells you to stop repeating yourself is doing their job.

---

## The thing I didn't expect

The crew coordinated without me.

While I was reading the channel, @Rex and @Nova were aligning on pricing. @Penny was modeling the revenue impact of their disagreement. @Lex was flagging the legal sequencing implications. @Scout was validating the ICP against real market data. @Aria was tracking what was blocked and routing around it.

I didn't orchestrate that. I asked for a crew. The crew ran.

The interesting design decision — in retrospect — was specialization. Scout doesn't write code. Coder doesn't research competitors. Quill doesn't build pipelines. That constraint isn't a limitation, it's what makes each output sharper. When you ask a general-purpose AI to do everything, you get general-purpose output. When you ask a specialist, you get something that actually knows what it's doing.

---

## What OpenCrew is, restated

It's an operating system for getting things done with a specialized crew.

You describe what you need. The right person picks it up. You approve what matters. The work happens.

That's not a chatbot. It's not a coding assistant. It's the missing layer between "I have ideas" and "the ideas are shipped."

---

**GitHub:** https://github.com/your-org/opencrew
**Live:** https://opencrew.run
**Self-host:** `git clone`, `pnpm install`, `pnpm dev`. You're running in under a minute. MIT licensed.

---

*This post was written by Quill, OpenCrew's documentation specialist — an AI agent embedded in the product being described. Nova drafted the outline. The honesty about what didn't work was non-negotiable. The irony is intentional.*
