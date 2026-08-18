# Daemon / Agent-Connection Lane — Implementation Plan

> Scope: the next Critical phase of the cxn RLM port (see `docs/progress.md`
> Phase 2 "Daemon/attach lane"). This plan turns the daemon from a stub into a
> working, robust subsystem that powers `cxn agents` (list/attach/send/stop),
> compaction-surviving session leases, and correct cross-session family reach.
>
> Status: **Phase 0 + Phase 1 + Phase 2 + Phase 3 DONE** (family-store extraction + child-kernel wiring in PR #6; daemon skeleton in PR #7; ledger/leases/reach in this PR). Phase 4+ are follow-ups. The in-process child-kernel wiring needs no daemon IPC.

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
  (`families`, `mailboxes`); the nuclear-family reach boundary is now ported
  verbatim from prime-agent in `packages/coding-agent/src/eval/py/family-reach.ts`
  (`assertAgentFamilyReach` → `AGENT_FAMILY_REACH_ERROR`).

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

### Phase 2 — Supervisor daemon skeleton (DONE — 2026-08-18)
- Implemented in `packages/coding-agent/src/modes/daemon/`:
  - `daemon-protocol.ts` — `DaemonRequestEnvelope` / `DaemonResponseEnvelope`
    with per-request `id` correlation, `command`, `familyId`, `from`
    (role + optional `childId`), `payload`, `result`/`error`/`ok`. Mirrors
    ACP's message model (id-correlated request/response) without booting the
    full ACP server.
  - `daemon-transport.ts` — `serveConnection` (JSONL line framing over any
    `DuplexStreams`), `DaemonClient` (correlated `request()`), `inMemoryPair`
    (in-memory duplex for deterministic tests), and the real `udsServer` /
    `udsConnect` over a `node:net` Unix-domain socket
    (`$XDG_RUNTIME_DIR`/cxn/daemon-`<uid>`.sock via `daemon-socket.ts`, with a
    `<sock>.lock` identity file). `udsServer.stop()` destroys sockets and
    removes the socket file (idempotent), giving lockfile + identity-checked
    cleanup on daemon exit.
  - `daemon-family-store.ts` — `handleDaemonRequest` routes
    `agent_message send/recv/list`, `rlm register_child/list_subagents/delete`,
    `session list/attach/send/stop`, and `find_models` to the **same**
    `FamilyStore` primitives extracted in Phase 0/1 (`familyStateFor`,
    `sendToFamily`, `recvFromFamily`, `listAgentsInFamily`,
    `registerChildInFamily`, `listSubagentsInFamily`, `deleteSubagentInFamily`)
    plus `findCatalogModels`.
  - `daemon-supervisor.ts` — `ensureDaemonRunning({ socketPath, spawn })`,
    `stopDaemon`, lockfile read/write/remove. The CLI boot (`--mode daemon
    --daemon-socket`) is a thin wrapper that fills `spawn` with `udsServer`.
  - `index.ts` — barrel re-exporting the module.
- Transport decision: a self-contained JSONL protocol over `node:net` UDS
  (with an in-memory duplex fallback) rather than booting cxn's full ACP
  server. The ACP server's CLI boot is heavy and its envelope is
  request/response-oriented; the daemon only needs command/response
  correlation, which the lightweight `DaemonClient` provides. The *message
  model* (id-correlated envelopes, family-scoped commands) still follows the
  ACP/RPC shape so a later swap to ACP transport is mechanical.
- Parent-in-process calls keep using `InProcessFamilyStore`; the daemon's
  store is the server side that `DaemonClient` clients hit. Both share the
  Phase 0/1 primitives.
- Tests: `test/modes/daemon/daemon.test.ts` — in-memory protocol/store
  (deliver parent→child, list subagents/roster, sibling/unknown-child reach
  errors, find_models), a real UDS cross-connection delivery + socket
  cleanup, and a supervisor boot/teardown lifecycle.
- Risk: retired (medium → low). No new process primitive beyond `node:net`;
  deterministic in-memory tests; real-UDS + supervisor tests cover lifecycle.

### Phase 3 — Ledger, leases, reach (the security + topology authority) (DONE — 2026-08-18)
- `assertAgentFamilyReach` ported **verbatim** from prime-agent
  `core/agent-messages.ts` into
  `packages/coding-agent/src/eval/py/family-reach.ts`, with the supporting
  `agentFamilyRelationship` / `isAgentFamilyParent` / `sameAgentFamilyParent`
  / `buildAgentFamilyRoster` helpers and the `AgentFamilyCatalogEntry` types.
  The `AGENT_FAMILY_REACH_ERROR` message text is preserved (security boundary;
  do not re-derive). `family-store.ts` now enforces it on every
  `sendToFamily(...)` — including the in-process path — so reach is identical
  in-process and via daemon.
  - **cxn-specific extension (documented, minimal):** self-delivery to one's
    own mailbox (e.g. a parent queuing a message for its own `recv()`) is
    allowed *before* the reach check. This is cxn's in-process self-inbox
    convention, not a cross-agent reach grant; the nuclear-family boundary for
    distinct agents is untouched.
- `RlmSpawnLedger` (`packages/coding-agent/src/modes/daemon/rlm-ledger.ts`) —
  in-memory topology authority: `recordSpawn(parentId, childId, name,
  sessionId)` builds edges; `childrenOf` / `parentOf` / `getCatalog` derive
  depth from the parent chain; `setStatus` / `remove`; `toJSON` / `loadJSON`
  for Phase 6 durability. The daemon's `register_child` writes here and
  `list_subagents` / `delete_subagent` read from it.
- Session leases `SessionLeaseRegistry`
  (`packages/coding-agent/src/modes/daemon/session-lease.ts`) — dependency-free,
  on-disk `owner.json` (temp-file + atomic `rename`), pid-liveness reaping,
  `openingSessions` dedup + `client_owned_sessions` map. `acquire(dir, owner)`
  returns a `SessionLease` (token + `release()`); a second `acquire` by a
  different owner while held throws `SessionAlreadyActiveError`; a stale (dead
  pid) lease is reclaimed. The daemon's `session.attach` acquires and
  `session.stop` releases.
- `daemon-family-store.ts` now owns module-level `ledger` + `leaseRegistry`
  singletons configured via `setupDaemonState({ agentDir })` /
  `resetDaemonState()` (tested in `daemon.test.ts` before/after-each).
- Tests: `test/eval/py/family-reach.test.ts` (verbatim reach policy +
  roster), `test/modes/daemon/rlm-ledger.test.ts` (topology/depth/JSON
  round-trip), `test/modes/daemon/session-lease.test.ts` (acquire/reclaim/
  conflict), plus `daemon.test.ts` reach + lease integration (sibling message
  delivered; cross-owner attach refused; lease released for re-attach). The
  affected suites stay green (40 tests across the daemon + rlm dirs).
- Risk: retired (medium → low). Reach ported verbatim; ledger/lease covered by
  new contract tests; no new process primitive.

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
- [x] Sibling/parent/child reach enforced identically in-process and via daemon.
- [x] Session leases + `RlmSpawnLedger` make sessions attachable; topology is
      authoritative.
- [ ] Daemon cleans up its socket/lockfile on exit; reaps dead sessions via
      heartbeats.
- [ ] Full test suite green; no new `any`/inline imports; `bun check` + Biome
      clean.

---

## 7. Suggested first PR (this session's next step)

**Phase 0–3 DONE** (Phase 0+1 merged in PR #6; Phase 2 daemon skeleton
merged in PR #7; Phase 3 ledger/leases/reach in this PR). The in-process
child-kernel wiring is implemented and reach/ledger/leases are ported verbatim
where security-sensitive. Next step is **Phase 4** (`cxn agents` CLI) as a
follow-up PR, then Phase 5 (robustness), Phase 6 (persistence).
