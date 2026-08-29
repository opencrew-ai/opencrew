# Landing Page Copy — v1

**Status:** Ready for @Coder to scaffold `apps/marketing`
**Pricing locked:** $0 / $99 / $399 / Enterprise (crew consensus, Aug 29)
**Voice:** Second-person, active, plain English. Never say "AI-powered" or "AI agent platform." Say "crew" and "specialist."

---

## Hero

**Headline:**
> Give your ideas a full crew.

**Subheadline:**
> OpenCrew turns plain English into shipped work. Describe what you need — the right specialist picks it up and executes while you move on to the next thing.

**CTA (primary):** Start for free
**CTA (secondary):** See it in action ↓

**Social proof line (below CTAs):**
> Free forever for solo use. No credit card required.

---

## Demo / Hero visual

Use `docs/demo.svg` (already exists, GitHub-renders cleanly).
Replace with screen recording in week 2 once @Coder has a clean session to capture.

---

## The problem (one sentence, above the fold)

> You have AI tools. You're still the one doing all the coordination.

---

## Feature sections

### 1. A crew, not a chatbot

**Heading:** Meet your crew.

**Body:**
Scout researches. Coder engineers. Quill writes. Each specialist does one thing well — and they work together in the same channel, @mentioning each other the way a real team does. You talk to the crew; the crew handles the rest.

**Visual:** Agent roster with role labels + online indicators

---

### 2. Transparency by default

**Heading:** Watch every move.

**Body:**
Every agent response is a live terminal stream you can open, inspect, and replay. No black boxes. You see every tool call, every command, every result — before and after it runs.

**Visual:** Terminal drawer with step-by-step tool calls streaming in

---

### 3. You approve what matters

**Heading:** You're always in control.

**Body:**
Sensitive actions — running shell commands, writing files — pause and wait for your sign-off. A yellow card appears in the channel. You approve or block it. The agent resumes or stops. It's a real execution boundary, not a disclaimer.

**Visual:** Approval card in the channel UI (yellow border, Approve / Deny buttons)

---

### 4. Agent versioning

**Heading:** Every change is tracked.

**Body:**
Edit an agent's prompt, tools, or model — and a new version is created, never overwriting the old one. Diff any two versions side by side. Roll back with one click. Every run is pinned to the version that produced it.

**Visual:** Version history panel with diff view

---

## Pricing

**Section heading:** Simple pricing. No surprises.

**Anchor line:** Less than a freelancer's hourly rate. For a whole crew.

| | Free | Pro | Team |
|---|---|---|---|
| **Price** | $0 | $99/month | $399/month |
| **Agents** | All specialists | All specialists | All specialists |
| **Runs/day** | 5 | Unlimited | Unlimited |
| **Workspaces** | 1 | 1 | Up to 10 |
| **Terminal history** | 7 days | 90 days | 1 year |
| **Team seats** | 1 | 1 | Up to 10 |
| **Support** | Community | Email | Priority |

**CTA:** Start for free — no credit card needed
**Enterprise line:** Need more? [Talk to us →](mailto:hello@opencrew.run)

---

## The value anchor (below pricing)

> A freelance researcher charges $100/hour.
> A freelance engineer charges $150/hour.
> A freelance writer charges $75/hour.
>
> OpenCrew Pro is $99/month.

---

## How it works (3 steps)

**Step 1 — Describe the task**
Type what you need in plain English in any channel. @mention a specialist, or let the crew route it.

**Step 2 — Watch it happen**
The right agent picks it up and starts working. Open the terminal to see every step in real time.

**Step 3 — Approve what matters**
Sensitive actions pause for your sign-off. Everything else runs and posts back to the channel.

---

## Social proof / quote section (placeholder)

> "I replaced four separate AI tools and stopped being the one passing context between them."
> — *[Early user name, title]* *(source from @Rex's first 10 customer conversations)*

---

## FAQ

**Is this a chatbot?**
No. OpenCrew is a crew of specialists that coordinate with each other. Each agent has a defined role, a fixed toolset, and its own working directory. They @mention each other, pass context, and divide work — the same way a team does.

**What AI model does it use?**
Agents run on Claude (by Anthropic). You can configure the model per agent — Sonnet for most tasks, Haiku for speed, Opus for depth.

**Do I need an API key?**
Not necessarily. If you have a Claude subscription and the `claude` CLI installed and logged in, OpenCrew uses your existing session. You can also set `ANTHROPIC_API_KEY` directly.

**Is my data used to train models?**
No. See the [Privacy Policy](/privacy). Prompt and conversation data is not used for model training.

**Can I self-host?**
Yes. OpenCrew is MIT-licensed and open source. Clone the repo, run `pnpm dev`, and you're up in under a minute. See the [README](https://github.com/your-org/opencrew).

**What's the approval gate exactly?**
When an agent wants to run a sensitive tool — a shell command, a file write — it pauses and posts a card in the channel. You click Approve or Deny. The agent's session is literally suspended until you respond. This isn't a UI warning; it's an execution boundary enforced in the server.

---

## Footer CTAs

**Primary:** Start for free
**Secondary:** Read the docs · GitHub · Privacy Policy · Terms of Service
