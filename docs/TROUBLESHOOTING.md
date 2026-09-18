# If it doesn't work

The five things that go wrong in the first ten minutes, and the fix for each. Anything else:
open an issue with the output of `pnpm start` and we answer fast.

**The install script stops at "Claude is not signed in".**
Agents run as your own Claude Code sessions, so Claude Code has to be logged in once:

```bash
claude login
```

Then re-run the install line. A subscription (Pro or Max) is enough; no API key needed.
`ANTHROPIC_API_KEY` in the environment also works.

**The browser opens but shows a sign-in form.**
Localhost is signed in automatically only when the browser is on the same machine. From
another device use `admin@opencrew.local` / `opencrew` and change it in Settings, or link
the workspace to opencrew.run. If you are on the same machine and still see the form, a
proxy in front of the app is rewriting the Host header; set `OPENCREW_LOCAL_AUTOLOGIN=1`
only if you trust every client that can reach it.

**"Port 5173 is already in use" (or 3001).**
Something else, often an older OpenCrew, holds the port. The installer picks the next free
ports; when starting by hand: `lsof -nP -iTCP:5173 -sTCP:LISTEN` to find it, or set
`OPENCREW_WEB_PORT` and `PORT`.

**The Captain replied, but the worker never proposed anything.**
Click **terminal** on the worker's message. The usual causes are a Claude rate limit
(the server log prints `⏳ ... rate limit`), a dev server the worker could not start on its
port, or a repo with no commits yet. Workers need a commit to check out from; OpenCrew makes
one for you when you create the project, but a repo you emptied by hand will not have it.

**"Could not set up a git repo in …".**
OpenCrew turns the folder you gave it into a git repo (committing only `.opencrew/`). It
needs write access there. Pick a folder you own, or leave the field empty and OpenCrew keeps
a repo for the project under `data/repos`.

**Agents say the Chrome tools are missing.**
The `Chrome` tool drives your own browser through the
[Claude in Chrome](https://claude.com/chrome) extension. Install it, keep Chrome open, and
drag the tab you want the agent to see into the Claude tab group. The `Browser` tool needs
no extension; it launches its own Chrome with a persistent profile.

**Remove everything.**

```bash
curl -fsSL https://opencrew.run/install | bash -s -- --uninstall
```

Your repos are untouched: OpenCrew only ever wrote to `.opencrew/` and to commits you
approved.
