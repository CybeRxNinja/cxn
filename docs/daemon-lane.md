# Daemon / Agent-Connection Lane — Implementation Plan

> Scope: the next Critical phase of the cxn RLM port (see `docs/progress.md`
> Phase 2 "Daemon/attach lane"). This plan turns the daemon from a stub into a
> working, robust subsystem that powers `cxn agents` (list/attach/send/stop),
> compaction-surviving session leases, and correct cross-session family reach.
>
> Status: **Phase 0 + Phase 1 DONE** (implemented in `eval/py/family-store.ts` + `rlm.ts`, merged via PR). Phase 2+ are follow-ups. The in-process child-kernel wiring needs no daemon IPC.

---

## 0. Corrected architecture (read this first)

Earlier notes claimed RLM children "run as subprocesses with their own
in-memory family state." **That is wrong for cxn's current code.** Tracing
`runStructuredSubagent` → `runSubprocess` (`packages/coding-agent/src/task/executor.ts`)
shows the child is created with `createAgentSession(...)` and run by an
in-process `monitor` (`monitor.takeActiveSession()` / `monitor.finish()`).
There is **no `Bun.spawn`** — children are nested *in-process* sessions and
share the parent process's `families` map.

So the actual child-kernel bug is narrower than "needs IPC":

- `familyFor(session)` keys the family map by `session.getSessionId()`.
- A child session has its **own** session id, so `familyFor(childSession)`
  creates a *separate, empty* family for the child.
- The child's `agent_message.recv()` therefore looks at an empty mailbox, not
  the parent's.

**Consequence:** child↔parent messaging does **not** require a daemon. It
requires (a) the child session to carry its RLM identity (`getRlmRole()` /
`getRlmChildId()`), and (b) `familyFor` to resolve a child to its **parent's**
family. That is a small, safe, in-process fix (Phase 1 below) — deliverable
now, with no new process or socket.

The daemon is still required, but for a *different* job: **cross-process**
authority. Specifically `cxn agents` (a separate terminal attaching to a
session), persistent/attached agents that survive the spawning parent, and
sibling messaging **across different parent sessions** (different processes).
For those, the authoritative family/session state must live in a process that
outlives any single parent — the supervisor daemon.

### What cxn already has (reuse, don't rebuild)
- **ACP** — `@cxn/pi-utils/acp` (`AgentSideConnection`, `ndJsonStream`,
  `Stream`) + `packages/coding-agent/src/modes/acp/` (`acp-agent.ts`,
  `acp-mode.ts` with `runAcpMode`, `acp-client-bridge.ts`). A complete
  JSON-RPC agent-communication server. This is the transport to reuse.
- **Headless RPC** — `packages/coding-agent/src/modes/rpc/` (`rpc-types.ts`
  `RpcCommand`, `rpc-client.ts`, `rpc-subagents.ts`) with `get_subagents`,
  `parentSession`, `set_subagent_subscription`, etc.
- **Family/mailbox logic** — `packages/coding-agent/src/eval/py/rlm.ts`
  (`families`, `mailboxes`, `assertAgentFamilyReach` → today's
  `AGENT_FAMILY_REACH_ERROR`).

### What prime-agent has (the gold target, in `research/upstream/prime-agent`)
- `modes/daemon/` — `daemon-supervisor.ts`, `daemon-socket.ts`,
  `daemon-client.ts` (UDS JSONL + `request()`), `rlm-ledger.ts`
  (`RlmSpawnLedger`), `daemon-supervisor-ownership.ts`, `heartbeat-catalog.ts`,
  `command-recovery-journal.ts`, `saved-session-catalog.ts`, `daemon-errors.ts`.
- `modes/agent-connection/` — **both** `in-process-agent-connection.ts` and
  `daemon-agent-connection.ts` behind one `AgentConnection` interface. This is
  the exact hybrid pattern to mirror.
- `core/agent-messages.ts` — `assertAgentFamilyReach` (the security boundary:
  "Agent reach is limited to parent, siblings, and children").
- CLI — `cli/command-registry.ts` + `cli/daemon-command.ts` (`agents` TUI +
  `list/attach/send/stop`, `prime-agent daemon <...>`).

---

## 1. Goals / Non-goals

**Goals**
1. Child kernels wired into the family — a child's `agent_message.recv()`
   drains its own mailbox (in-process, no daemon). [Phase 1]
2. A supervisor **daemon** process: owns session runtimes + family/mailbox
   state + session leases; serves ACP over a UDS socket. [Phase 2–3]
3. `cxn agents` CLI: `list` / `attach` / `send` / `stop` against the daemon.
   [Phase 4]
4. Session leases + `RlmSpawnLedger` so sessions are attachable and topology is
   authoritative. [Phase 3]
5. Compaction-surviving persistence of leases + ledger. [Phase 6]
6. Robustness: heartbeats, reconnect, crash isolation, lockfile cleanup.
   [Phase 5]

**Non-goals (explicitly out of scope — avoid scope creep)**
- Do **not** port prime-agent's entire `AgentConnection` interface (it is the
  whole TUI↔session boundary; cxn already has `interactive-mode.ts`, `rpc/`,
  `acp/`). We port only the *daemon-specific* primitives (ledger, lease,
  socket/client, reach, CLI), reusing cxn's existing transport.
- Do **not** change cxn's in-process child-execution model into OS
  subprocesses. Keep children in-process; the daemon is an *authority* for
  cross-process clients, not the owner of every transient child.
- Do not re-implement the TUI; `agents` is a CLI (port prime-agent's
  `agents` subcommands, not its full TUI).

---

## 2. Core design: one `FamilyStore` abstraction, two implementations

Mirror prime-agent's `InProcessAgentConnection` / `DaemonAgentConnection`.

```
interface FamilyStore {
  // family registry + mailboxes, currently in rlm.ts
  listRoster(session): AgentFamilyRosterEntry[]
  send(session, msg): AgentMessageReceipt
  recv(session, opts): AgentMessage[]
  // ledger + leases (Phase 3)
  recordSpawn(parentId, childId, name): void
  acquireLease(sessionId, owner): Lease
}
```
- `InProcessFamilyStore` — wraps the **existing** `families`/`mailboxes` map
  in `rlm.ts`. Used when the session is not daemon-owned (the common,
  fast, in-process parent↔child path). No serialization, no socket.
- `DaemonFamilyStore` — talks to the supervisor daemon over ACP/UDS
  (`DaemonClient.request(...)`). Used by `cxn agents` clients and by
  daemon-owned (persistent/attached) sessions.

The `rlm.ts` / `agent_message` bridges select the store from the session
(`session.getFamilyStore()` or a module-level resolver keyed by whether the
session is daemon-owned). **The bridge call sites and the Python prelude
`agent_message.*` / `rlm.*` API do not change** — only the store behind them.

This keeps the in-process path zero-cost and makes the daemon a strictly
additive authority.

---

## 3. Phased implementation

### Phase 0 — Extract the store (DONE)
- Move `families` / `mailboxes` / `resetRlmFamilies` / roster + the
  send/recv/rate-limit logic out of `rlm.ts` into
  `packages/coding-agent/src/eval/py/family-store.ts` as
  `InProcessFamilyStore` implementing `FamilyStore`.
- `rlm.ts` delegates to it. **All existing `rlm.test.ts` tests stay green.**
- Risk: low. Pure extraction.

### Phase 1 — Child kernels wired into family (DONE — 2026-08-18)
- **Implementation note:** rather than injecting `getRlmRole()`/
  `getRlmChildId()` into the child `ToolSession`, we use the signal that is
  *already* available: the structured-subagent executor sets the child's
  `getAgentId()` to the reserved `rlm_child_id` (`buildSubagentSessionOptions`
  → `agentId: id`). So a child is identified purely by `session.getAgentId()`
  with **zero spawn-path injection**.
- `family-store.ts` keeps a `childToFamilyKey: Map<childAgentId, parentFamilyKey>`
  populated at spawn by `registerRlmChildFamily(childId, family.parentId)` in
  `rlmRun`. `familyFor(session)` resolves a child (via `rlmChildContext`) to its
  parent's family; `agentMessageRecv` for a child reads its mailbox keyed by its
  `rlm_child_id` within that family → drains its real mailbox.
- Tests (added to `rlm.test.ts`, now 19 tests): a parent sends to a child, the
  child's own `agent_message.recv()` (as a child session with `getAgentId()`)
  drains the message; a child cannot read a sibling's mailbox; a child's send
  reaches the parent mailbox.
- Risk: low. No spawn-path change; covered by new contract tests.

### Phase 2 — Supervisor daemon skeleton (reuse ACP)
- New `packages/coding-agent/src/modes/daemon/`:
  - `daemon-socket.ts` — UDS at
    `$XDG_RUNTIME_DIR`/cxn/daemon-`<uid>`.sock (+ lockfile with pid/identity
    for cleanup). Reuse `@cxn/pi-utils/acp` `ndJsonStream` for framing, or
    port prime-agent's `daemon-socket.ts` JSONL if ACP's envelope doesn't fit
    command/response correlation (prime-agent correlates by
    `DaemonCommandEnvelope.id` echoed in `DaemonResponse`).
  - `daemon-supervisor.ts` — lazy-spawned singleton per user
    (`ensureDaemonRunning`, detached; `--mode daemon --daemon-socket <path>`).
    Owns the **authoritative** `FamilyStore` (a `DaemonFamilyStore` server
    side) + session registry + lease table.
  - Handlers: `agent_message send/recv/list`, `rlm list_subagents/delete`,
    `find_models` (static, can stay local), `session list/attach/send/stop`.
- Parent-in-process calls keep using `InProcessFamilyStore`; the daemon's
  store is the server side that `DaemonFamilyStore` clients hit.
- Risk: medium. New process + lifecycle. Reuse ACP to minimize new protocol.

### Phase 3 — Ledger, leases, reach (the security + topology authority)
- Port `rlm-ledger.ts` → `RlmSpawnLedger` (durable spawn edges:
  parent→child, name, session id). This is the **topology authority** used to
  compute family reach, so it must be ported together with reach.
- Port `assertAgentFamilyReach` **verbatim** from
  prime-agent `core/agent-messages.ts` (nuclear family = parent/sibling/child
  from depth + shared parent). It is the security boundary; do not re-derive.
- Session leases: `acquireSessionLease` (on-disk `owner.json` lock) +
  lifecycle `resident` / `client_owned` + `client_owned_sessions` capability +
  `openingSessions` dedup (port `daemon-supervisor-ownership.ts`). Makes
  attach/send/list coherent through one registry.
- Risk: medium. Reach is security-sensitive — port verbatim + keep the
  existing `AGENT_FAMILY_REACH_ERROR` contract in tests.

### Phase 4 — `cxn agents` CLI
- Port prime-agent `cli/command-registry.ts` + `cli/daemon-command.ts`
  `agents` subcommands: `cxn agents list`, `cxn agents attach <id>`,
  `cxn agents send <id> <msg>`, `cxn agents stop <id>`.
- Client uses `DaemonFamilyStore` (ACP/UDS) → `DaemonClient.request(...)`.
- Risk: low/medium. Thin CLI over the Phase 2–3 handlers.

### Phase 5 — Robustness
- Heartbeats: port `heartbeat-catalog.ts` + cron heartbeats
  (`core/cron-jobs.ts`) so the daemon reaps dead/idle sessions and detects
  stale leases.
- `DaemonClient` request-recovery / reconnect with backoff.
- Supervisor-relaunch + worker fence-checks; `uncaughtException` handlers.
- Lockfile socket + identity-checked cleanup on daemon exit.
- Risk: medium. Defense-in-depth; each piece has a test (reap, reconnect,
  cleanup).

### Phase 6 — Compaction-surviving persistence (follow-up)
- Serialize `RlmSpawnLedger` + lease table + mailbox cursors to disk
  (port `saved-session-catalog.ts` / `command-recovery-journal.ts`).
- `cxn agents attach` reloads a session's runtime/state from the ledger.
- Risk: medium. Depends on Phase 3 ledger being the authority.

---

## 4. Testing strategy (contract-first, per AGENTS.md)

- **Phase 0**: extraction — existing `rlm.test.ts` (16 tests) must stay green.
- **Phase 1**: spawn-seam test — parent sends → child's `recv()` (as child
  session) drains; sibling-mailbox read rejected. Negative contracts required.
- **Phase 2**: daemon lifecycle test — start daemon, connect ACP client,
  `send`/`recv` across the socket, shutdown cleans the socket+lockfile.
- **Phase 3**: reach test — port prime-agent's `assertAgentFamilyReach`
  cases (parent/child/sibling allowed; aunt/cousin/stranger rejected);
  ledger topology drives reach.
- **Phase 4**: `cxn agents` e2e — scripted CLI against a live daemon
  (list shows spawned children; attach + send delivers).
- **Phase 5**: robustness — kill a child process → daemon reaps + marks
  completed; drop the socket → client reconnects; daemon crash → lockfile
  cleanup on relaunch.

Every test asserts an **observable contract** (delivered message, rejected
reach, cleaned socket), never "the code ran."

---

## 5. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Changing `familyFor` keying breaks existing tests | Phase 0 extraction + Phase 1 tests guard the contract; child path is opt-in via `getRlmRole()`. |
| Daemon socket conflicts / leaks | Lockfile with pid + identity-checked cleanup (Phase 5); unique per-uid path. |
| Reach regression (security) | Port `assertAgentFamilyReach` verbatim; keep `AGENT_FAMILY_REACH_ERROR` tests. |
| Scope creep (porting whole `AgentConnection`) | Explicit non-goals (§1); port only daemon-specific primitives. |
| In-process vs daemon store divergence | Single `FamilyStore` interface; both impls share the same test suite. |

---

## 6. Definition of done

- [ ] `cxn agents list/attach/send/stop` work against a running daemon.
- [ ] A child's `agent_message.recv()` drains its mailbox (in-process).
- [ ] Sibling/parent/child reach enforced identically in-process and via daemon.
- [ ] Session leases + `RlmSpawnLedger` make sessions attachable; topology is
      authoritative.
- [ ] Daemon cleans up its socket/lockfile on exit; reaps dead sessions via
      heartbeats.
- [ ] Full test suite green; no new `any`/inline imports; `bun check` + Biome
      clean.

---

## 7. Suggested first PR (this session's next step)

**Phase 0 + Phase 1 — DONE (merged).** The in-process child-kernel wiring is
implemented in `eval/py/family-store.ts` + `rlm.ts` and unblocks the
"child kernels wired into family" item (no longer daemon-blocked). Next step
is **Phase 2** (supervisor daemon skeleton reusing cxn's existing ACP) as a
follow-up PR, then Phase 3 (ledger/leases/reach), Phase 4 (`cxn agents` CLI),
Phase 5 (robustness), Phase 6 (persistence).
