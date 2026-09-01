# OpenCrew Coordination Layer — The Task Fabric

**Status:** v2 design, adopted 2026-09-01. Phase 1 implemented (see [Adoption plan](#adoption-plan)).
**Goal:** maximize **throughput** — concurrent useful agent turns per hour — while staying
crash-only and keeping the human's final say structural.

---

## 0. What we optimize

Time-to-outcome for a piece of work = queue wait + serial bottleneck + turn time.
Turn time belongs to the model. The coordination layer owns the other two, and both
were previously dominated by two defects:

1. **False serialization** — work serialized on the *agent*, when the only physical
   constraints are the Claude Code *session* (breaks under concurrent resume) and
   exclusive devices (a Chrome profile, a shared working directory).
2. **Capacity held by waiting** — queued runs held global slots while waiting for an
   agent lock; approval gates blocked a live slot on an in-memory promise for up to
   30 minutes.

Everything in this design follows from removing those two. Every mechanism must
either increase parallelism, survive failure without a human babysitting it, or
route a decision to the human. Anything else is accidental complexity.

## 1. Principles

1. **The database is the only truth. Everything else is a disposable cache.**
   Sessions, worktrees, browser profiles — caches. Losing one is never an error;
   a fresh attempt rebuilds context from the DB transcript.
2. **Everything is a task.** A triggered agent turn, a plan step, an approval, a
   review: one table, one state machine, one scheduler. (Phase 1 unifies agent
   turns; see Adoption plan for the rest.)
3. **Crash-only.** There are no recovery code paths. Leases expire; ready tasks get
   claimed; parked tasks survive restarts. Kill -9 anything at any moment.
4. **Level-triggered, not edge-triggered** (the Kubernetes lesson). Controllers act
   because *current state* says something needs doing, never because an event
   arrived. Events (an in-process wake bus today, LISTEN/NOTIFY when the control
   plane is multi-process) are only a latency optimization; a periodic resync is
   the ground truth. Missed wake-ups can never lose work.
5. **Parallel by default; serialize only physics.** One active attempt per
   *session key* (role + conversation); exclusive devices by declared capacity.
   Nothing else ever waits on anything except its declared dependencies or a
   human decision.
6. **The human's final say is a state, not a feature.** The only thing that ever
   waits on a person is a task in `needs_human` — which is exactly what the
   Needs-You inbox renders. You can't break the promise without dropping a column.

## 2. The model

### Task

The unit of scheduled work. Phase 1 kind: `turn` (one turn of an agent's Claude
Code session). Spec fields are written once; status fields are mutated by
controllers.

```
fabric_tasks
  id                -- equals the run id for kind='turn' (1:1 UI compatibility)
  kind              -- 'turn'
  lane              -- 'interactive' | 'background'
  session_key       -- serialization domain: agentId:channelId:threadKey
  devices           -- json string[] of exclusive resources (browser profile, repo dir)
  payload           -- json, kind-specific (trigger info, resume grant)
  state             -- ready | leased | needs_human | done | failed | cancelled
  attempts          -- claims so far (budget: max_attempts, default 3)
  not_before        -- unix ms; scheduling hold
  lease_owner / lease_beat_at / lease_expires_at
  pause             -- json gate info while needs_human ({approvalId})
  version           -- optimistic concurrency counter
```

State machine:

```
ready ──claim──▶ leased ──complete──▶ done
  ▲                │ ├──gate()──▶ needs_human ──decision──▶ ready   (park/unpark)
  │                │ └──error──▶ (attempts < max) ready │ failed
  └── lease expired ┘                                      failed ─▶ Needs-You
```

### Session key — the serialization domain

`agentId:channelId:threadKey`. At most one leased task per session key, because a
Claude Code session cannot be resumed concurrently — that is the *only* reason.
The same agent runs in parallel across different conversations. This replaces the
per-agent lock and is the single biggest throughput change: an agent is no longer
a scarce resource, it's a costume.

### Devices — declared exclusivity

A task declares the exclusive resources it needs; the scheduler counts them like
capacity-1 resources:

- `browser:<profile>` — a Chrome profile supports one instance.
- `dir:<path>` — a **configured** working directory (a real repo) is exclusive:
  two sessions editing one checkout corrupt real work. Fallback scratch
  workspaces are not locked (collisions are unlikely and non-catastrophic).
  Phase 2 replaces the repo lock with a git worktree per attempt, making
  same-repo work truly parallel; the merge path already exists
  (`propose_change` → review → human commit).

### Lanes — throughput without starving the human

- `interactive` — the trigger chain roots at a live human message. A small
  reserved share of capacity (default 2 slots) is claimable only by this lane.
- `background` — agent-delegated, scheduled, review work.

Total concurrency defaults to 8 concurrent turns (`OPENCREW_CONCURRENCY`); turns
are network-bound, so width is cheap. Raise it for throughput; the reserve keeps
the workspace feeling instant at full load.

## 3. Controllers — level-triggered loops

All controllers share one invariant: **every ready task is leased, or about to
be.** Each runs `observe → diff → act` on wake events *and* on a periodic resync;
none of them care why a task became ready.

| Controller | Logic |
|---|---|
| **Scheduler** | claim ready tasks: `not_before` passed ∧ session key free ∧ devices free ∧ lane capacity free, ordered by lane priority then age. Hand to the worker pool. |
| **Reaper** | leased ∧ lease expired → process died → attempt over: back to `ready` within budget, else `failed`. Restart recovery **is** this loop — boot runs no special code. |
| **Stall detector** | leased ∧ no session events for 10 m → honest-doubt label ("quiet Xm — possibly stuck"); 30 m with no tool in flight → abort attempt → redeliver. A tool in flight (long build) heartbeats the lease and is bounded only by the 30 m overall turn timeout. |
| **Attempt budget** | folded into reaper/failure path: `attempts ≥ max` → `failed`, surfaced in the conversation and Needs-You. A fresh @mention retries with a fresh budget. |

Because redelivery resumes the same persistent session (or cold-starts from the
DB transcript if the session cache is gone), a re-attempt *continues* work, not
restarts it.

## 4. Approvals — park, never block

The old flow blocked the session inside its permission callback on an in-memory
promise: a held slot, a held agent, lost on restart (boot denied all pending
approvals). New flow:

1. **Gate hit** (PreToolUse — the one true choke point): write the approval row,
   post the approval card, deny the call with "paused for approval", abort the
   turn, save the session, park the task (`needs_human`, `pause={approvalId}`).
   The slot frees immediately. Parked tasks cost zero capacity and **survive
   restarts** — pending approvals now outlive the process.
2. **Approve** → the approval row becomes a **one-shot grant**: on the resumed
   attempt, a gated call matching (tool, exact input) consumes it
   (`consumed_at`) and passes without a second ask. The task unparks to `ready`
   with resume context; the next attempt's prompt says exactly what was approved.
   Different input → a fresh approval cycle (honest, no silent widening).
3. **Deny** → unpark with the denial as context: "do not retry it; adjust or wrap
   up." Denial stops the *call*, not the run.

Standing auto-approve rules are unchanged (still audited). The dead-session guard
("approving into a dead run") remains: approving a task that is no longer parked
is refused honestly.

## 5. Failure model

| Failure | Detector | Recovery |
|---|---|---|
| Process/worker death mid-turn | Lease expiry | Re-attempt from session/transcript, within budget |
| Model stalled, process alive | Stall sweep (event silence) | Label at 10 m, abort + redeliver at 30 m |
| Long tool call (30 m+ build) | Tool-in-flight heartbeat | Not killed by stall sweep; bounded by turn timeout |
| Poison task | Attempt budget | `failed`, dead-lettered to the human with full timeline |
| Server restart | Nothing special | Leases expire → reaper redelivers; parked tasks and pending approvals survive |
| Crash between message and trigger | Transactional-adjacent enqueue (run + fabric task written together at post time) | No lost triggers |
| Duplicate side effects on redelivery | *(phase 2)* effects ledger keyed (session, tool_use_id) | At-least-once today — the one accepted gap |

## 6. What died

`RunQueue` (in-memory FIFO), `agentLocks`, `approvalWaiters`, `activeRuns` as a
context-level map, `failInterruptedRuns` boot scan, the watchdog subsystem,
requeue-marker delivery counting (`— requeued` error strings), deny-all-approvals
on restart, `spawn_parallel`'s reason for existing (same-agent parallelism is now
structural across conversations).

## 7. Throughput analysis

Where turns/hour used to be lost, and what happens now:

| Loss | Before | After |
|---|---|---|
| Head-of-line blocking | Queued runs for a busy agent held global slots (4 total) — one chatty `*`-watcher could freeze the workspace | Scheduler never claims an ineligible task; slots only ever hold *running* work |
| Same-agent serialization | Strict serial per agent, even across unrelated threads | Serial per (agent, conversation) only; an agent works N threads at once |
| Approval waits | Slot + agent held up to 30 m per gate | Parked at zero capacity; decision returns as a grant |
| Capacity | Fixed 4 | Default 8, env-tunable; interactive reserve keeps latency under load |
| DAG plans | Structurally parallel, practically serialized by agent locks | Unblocked plan steps actually run wide |

## Adoption plan

**Phase 1 (implemented):** the fabric kernel replaces the run-scheduling
machinery under the existing product surfaces. `runs`/`run_steps`/`approvals`
rows are still written 1:1 (task id = run id) so the web UI, stats, replays and
thread shares work unchanged. The shared task board still dispatches by posting
action-thread messages, which trigger admission → fabric tasks — so the DAG rides
the fabric without new plumbing.

**Phase 2:** git worktree per attempt for configured repos; effects ledger
(exactly-once side effects); fabric-native events table absorbing `run_steps`.

**Phase 3:** plan steps and human requests become fabric tasks natively
(`kind` ≠ `turn`); Needs-You reads `needs_human` directly.

**Phase 4:** multi-process control plane — the store API becomes the worker
protocol (`claim / emit / gate / complete` over WSS), LISTEN/NOTIFY replaces the
in-process wake bus, OnCell cells join as workers. The kernel does not change
shape for this; only the transport does.
