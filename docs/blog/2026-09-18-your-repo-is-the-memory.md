# Your repo is the memory

*September 18, 2026 · Anup Singh*

Every AI agent product I have used keeps its memory somewhere I can't see. A vector store,
a "context" table, a summary the agent wrote for itself. When the agent is right, fine.
When it is wrong, I have no idea what it was remembering, and when I stop paying, whatever
it learned about my project goes with it.

OpenCrew now does the opposite. Its memory is your repo.

## What changed

Every project in OpenCrew has a git repo. If you give one, that's it. If you don't, OpenCrew
keeps one for you. If you point at a folder that isn't a repo yet, it runs `git init` there
and commits exactly one thing, a folder called `.opencrew/`.

That folder is the whole record:

```
.opencrew/
  plans/launch-checklist.md    a doc the crew proposed and you approved
  notes/pricing.md             another one
  decisions.md                 one line per approval, rejection, or change request
```

When an agent proposes a plan, it sits in the app for review like before. You comment on a
sentence, you send it back, it comes back revised. Nothing touches the repo. Then you press
approve, and the approval **is** a commit: the doc as a file, plus one line appended to
`decisions.md`, in the same commit. Approving a code change works the same way, the reviewed
patch and its decision line together. Reject something and one line lands in `decisions.md`,
nothing else.

The part I like most: the review itself goes with the commit. Your comments, who approved,
which revision it was, all of it is a git note on that commit. Here is a real one, from a
project I ran this evening, on a machine with no OpenCrew installed:

```
$ git log --notes=opencrew -1
b05ebb2 docs: Shop Launch Checklist (v1)
Notes (opencrew):
    OpenCrew review · "Shop Launch Checklist" v1 (plan)
    Proposed by agent Captain; approved by anup-singhai.
    Review comments:
    - anup-singhai: Good. Keep step three about the announcement.

$ cat .opencrew/decisions.md
- 2026-09-18 · Approved "Shop Launch Checklist" v1 · anup-singhai · .opencrew/plans/shop-launch-checklist.md
```

A new engineer can read a month of a project from `git log`. So can an acquirer. So can you
in a year.

## Why this shape

Three reasons, in order of how much I care.

**It survives everything.** People leave. Tools get replaced. Companies get bought. A record
that lives in the repo survives all three, because the repo is the one thing every team
already keeps forever. Push it and the memory goes with it. Clone it into a fresh OpenCrew
and the crew picks up the history. Stop using OpenCrew entirely and you lose nothing.

**Agents and people read the same thing.** An agent's prompt lists the docs by path and the
latest decisions; `read_doc` returns the file. If you fix a typo in your editor, that is what
the crew sees next turn. There is no second copy that drifts.

**Answers you can check.** You can now ask a project's Captain a question on a private line:
*what did we decide about the launch, and where is it written down?* The answer cites
`.opencrew/plans/shop-launch-checklist.md@b05ebb2`. That is a file at a commit. You can
open it without trusting anyone.

## What I deliberately didn't build

I had an eight-day plan for a memory table, a vector index, and an export format with a
manifest. I threw it away. A memory table is a second source of truth. An export format is
something git already is. Embeddings can come later, on top of files, if search over
`.opencrew/` ever gets slow enough to matter. It won't for a long time.

I also kept the folder in the product repo rather than a sibling "crew" repo. Crew decisions
next to product code means they show up in normal pull requests, which is the point.

## Try it

One line, two minutes, on the Claude plan you already have:

```
curl -fsSL https://opencrew.run/install | bash
```

Name a product, ask its Captain for a plan, approve it, then run `git log --notes=opencrew`
in your repo. If the first thing that breaks is something else, tell me. That is the bug I
fix next.

github.com/opencrew-ai/opencrew
