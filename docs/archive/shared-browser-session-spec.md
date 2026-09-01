# Shared Browser Session Spec

**Author:** Forge  
**Status:** Ready to implement  
**Estimated effort:** 2–3 hours  
**Problem:** Each browser-enabled agent gets its own Chrome profile at `workspacesDir/{agentId}/.browser-profile`. Herald logs in to X; Surf opens a blank profile. Anup has to log in again every time a different agent needs the browser.

---

## The Gap

```
workspacesDir/
  {heraldId}/.browser-profile/   ← Herald's logins (X, Gmail, LinkedIn...)
  {surfId}/.browser-profile/     ← blank — Surf has never logged in
  {coderId}/.browser-profile/    ← blank
```

Every agent that touches a browser starts from zero. Sessions are siloed by agent identity, not by the **human** who owns them.

---

## The Fix: Shared Profile

Add a `_shared/.browser-profile` directory at the workspace level. Any agent that opts in gets launched with that profile instead of its own.

```
workspacesDir/
  _shared/.browser-profile/      ← NEW: Anup logs in once here
  {heraldId}/.browser-profile/   ← Herald keeps its own (for private agent sessions)
  {surfId}/.browser-profile/     ← Surf opts in → gets the shared profile
```

Anup logs in to X, Gmail, LinkedIn, etc. in the shared profile **once**. Every agent that uses the shared profile has immediate access.

---

## Schema Change

Add `useSharedBrowserProfile?: boolean` to `AgentCapabilities` in `packages/shared/src/types.ts`.

Default: `false` (existing behavior preserved — no regressions).

When `true`: the agent's Playwright MCP server gets `--user-data-dir` pointing at `workspacesDir/_shared/.browser-profile` instead of `workspacesDir/{agentId}/.browser-profile`.

---

## Code Changes

### 1. `packages/shared/src/types.ts`

```diff
 export interface AgentCapabilities {
   canPostInChannels: string[]
   maxRunsPerHour: number
   requiresApprovalFor: string[]
   watchesChannels?: string[]
   workingDir?: string
+  useSharedBrowserProfile?: boolean
 }
```

### 2. `apps/server/src/runs/executor.ts`

In `browserMcpServer()`:

```diff
-const profileDir = join(env.workspacesDir, runEnv.agentId, '.browser-profile')
+const profileDir = runEnv.version.capabilities.useSharedBrowserProfile
+  ? join(env.workspacesDir, '_shared', '.browser-profile')
+  : join(env.workspacesDir, runEnv.agentId, '.browser-profile')
```

In the `prepareBrowserProfile` call above it:

```diff
-await prepareBrowserProfile(join(env.workspacesDir, runEnv.agentId, '.browser-profile'))
+const profileDir = runEnv.version.capabilities.useSharedBrowserProfile
+  ? join(env.workspacesDir, '_shared', '.browser-profile')
+  : join(env.workspacesDir, runEnv.agentId, '.browser-profile')
+await prepareBrowserProfile(profileDir)
```

### 3. `apps/server/src/routes/agents.ts`

```diff
   maxRunsPerHour: z.number().int().min(1).max(1000),
+  useSharedBrowserProfile: z.boolean().optional(),
```

### 4. `apps/server/src/tools/create_agent.ts`

No change needed — `useSharedBrowserProfile` defaults to `undefined` (falsy), which preserves existing behavior.

---

## UX: "Login Once" Flow

1. Agent page for any shared-profile agent shows a **"Open shared browser"** button
2. Button opens a window with `--user-data-dir` pointed at the shared profile
3. Anup logs in to X, Gmail, LinkedIn, etc. normally
4. All shared-profile agents immediately have those sessions on their next run

This is exactly what the Herald agent page already does for Herald's own profile — we're just pointing it at the shared directory.

---

## Concurrency Note

Chromium holds a `SingletonLock` file inside the profile. Two agents cannot run simultaneously against the same profile — the second will fail to launch.

**Mitigation:** The existing `prepareBrowserProfile()` function already clears stale lock files. Browser runs are serialized per profile (same as they are today per agent). For now this is acceptable — concurrent browser tasks are rare. Long-term fix: profile pooling (Phase 2 enhancement).

---

## Rollout

1. Implement type + executor changes (30 min)
2. Update Surf's agent config via UI to set `useSharedBrowserProfile: true`
3. Anup opens the shared browser once, logs in to X
4. Surf posts the tweet — no credentials needed, session already there

---

## Roadmap Addition

This unblocks:
- Social posting (X, LinkedIn) without API keys
- Web research with authenticated sessions (Notion, Linear, Salesforce)
- Any task that requires "log in as Anup" across multiple agents
