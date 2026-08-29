# OpenCrew Docs Style Guide

This is the working reference for anyone writing documentation on this project — README, guides,
changelogs, API docs, onboarding material. @Quill owns this file and updates it as conventions evolve.

---

## Voice and tone

| Do | Don't |
|---|---|
| **You** — address the reader directly | "The user should…" or "Developers can…" |
| **Active voice** — "The server generates a secret" | Passive — "A secret is generated" |
| **Plain English** — prefer common words | Jargon, Latin abbreviations (e.g./i.e.) |
| **Friendly-but-professional** — warm, not casual | Hypey ("blazing-fast!"), over-familiar ("enjoy pressing Approve") |
| **Specific** — concrete numbers and examples | Vague promises ("easy", "simple", "just") |
| **Present tense** — "The run pauses and waits" | Future tense — "The run will pause" |

---

## Structure

### Headers

- Use sentence case: `## Known limitations` not `## Known Limitations`
- One `#` H1 per document — the title
- Don't skip levels (H1 → H3 with no H2 in between)
- Keep headers short — they're navigation labels, not summaries

### Sections

Every doc should answer, in order:
1. **What is this?** — one-paragraph description, no assumed context
2. **How do I get started?** — prerequisites and the minimal path to running
3. **Reference** — config options, commands, API, etc.
4. **Advanced / contributing** — deeper detail for power users or contributors

### Lists

- Use bullet lists for unordered items (features, options, gotchas)
- Use numbered lists only for sequential steps
- Keep list items parallel — if one starts with a verb, all should
- Avoid nested lists more than one level deep

---

## Code and technical formatting

- Use `inline code` for: commands, file paths, variable names, env vars, function names, URLs
- Use fenced code blocks (` ``` `) for: multi-line commands, config files, code examples
- Always specify the language on fenced blocks: ` ```bash `, ` ```ts `, ` ```json `
- In shell examples, omit the `$` prompt — it prevents copy-paste
- In tables, keep column headers short; align content columns left

---

## Markdown conventions

- Separate sections with a horizontal rule (`---`)
- One blank line before and after code blocks, lists, and tables
- Use `**bold**` for emphasis on first mention of a key term or UI label
- Use `_italic_` sparingly — only for titles of external docs or genuine emphasis
- Avoid emoji in body copy; they're fine in changelogs and commit messages
- Keep line length ≤ 100 characters in source (makes diffs readable)

---

## Terminology

Use these terms consistently across all docs:

| Term | Use | Don't use |
|---|---|---|
| agent | "an agent" | bot, assistant, AI |
| run | "a run" (noun) | execution, job |
| channel | "a channel" | room, thread |
| approval | "an approval card" | gate, blocker |
| system prompt | "the agent's system prompt" | instructions, directive |
| workspace | "the agent's workspace directory" | folder, sandbox |
| admin | "an admin" | administrator, superuser |

---

## What to flag to @Coder before publishing

- Any doc change that describes code behavior (API contracts, guardrail logic, tool execution)
- Version numbers or default values that may drift over time
- Any "how it works" explanation that touches the run executor, guardrails, or versioning system

---

## Gaps to fill (backlog)

- [ ] `docs/CONTRIBUTING.md` — detailed contributor guide (branching, test expectations, PR checklist)
- [ ] `docs/AGENTS.md` — how to configure, version, and roll back agents
- [ ] `docs/TOOLS.md` — full tool authoring reference with MCP context API
- [ ] `docs/API.md` — REST + WebSocket API reference
- [ ] `CHANGELOG.md` — release history (start from v0.1.0)
- [ ] Demo GIF for README (coordinate with @Coder or @Forge to record)
