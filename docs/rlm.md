# RLM: recursive subagents and family messaging

The RLM (recursive language model) execution model lets an agent spawn
**recursive children** — full agent sessions that run detached from the
parent's turn — and exchange **family messages** with them. This document
describes cxn's adaptation: the semantics, the bridge surface, and the
current scope.

## Concepts

- **`rlm(prompt, name=…, model=…)`** admits a child immediately and returns a
  spawn handle `{ rlm_child_id, name, session_dir, model }`. The child runs
  detached as a real structured subagent (`runStructuredSubagent` with
  `keepAlive` + `retainArtifacts`), so it is a full agent session with its own
  tools, session dir, and — via the eval kernel — the same prelude helpers.
- **`rlm.list_subagents()`** returns the parent's retained children with their
  status (`running` | `completed` | `error`).
- **`rlm.delete_subagent(target)`** removes a settled child from the registry;
  running children are refused.
- **`agent_message`** routes messages within the family — parent ↔ direct
  children — through per-family mailboxes with `delivered`/`queued` receipts,
  `auto`/`steer`/`follow_up` delivery modes, per-mailbox pending caps, and a
  per-message size cap.

## Bridge surface

Both runtimes reach the host through the existing eval tool bridge:

| Python helper      | Bridge name            | Ops                                      |
| ------------------ | ---------------------- | ---------------------------------------- |
| `rlm.*`            | `__rlm__`              | `run`, `list_subagents`, `delete_subagent`, `find_models` |
| `agent_message.*`  | `__agent_message__`    | `list_agents`, `send`, `recv`            |

The host dispatch lives in `eval/js/tool-bridge.ts` (`callSessionTool`), which
routes the `__`-prefixed names to `eval/py/rlm.ts` (`runRlmBridge` /
`runAgentMessageBridge`). The Python helpers are defined in the prelude
(`eval/py/prelude.py`) and mirror the upstream callable API surface.

## Family state

Family registries and mailboxes are **in-memory**, keyed by the parent
session id (`ToolSession.getSessionId`). This means:

- Children are tracked for the lifetime of the parent process.
- Compaction-surviving persistence is a follow-up.
- Child kernels are not yet wired into the family (a child's own
  `agent_message.recv()` cannot drain its mailbox until that follow-up); the
  child→parent reply path is covered by the spawn-seam tests.

## Spawn machinery

Children are spawned through `runStructuredSubagent` with:

- `invocationKind: "eval"`
- `keepAlive: true` + `retainArtifacts: true` (recoverable artifacts, live
  registry references)
- `shareEvalSession: false` (eval bridge children must not share the parent's
  kernel)

Spawns are **fire-and-forget**: `rlm()` returns the handle as soon as the
child is admitted; the registry settles on the child's outcome when it
completes. The spawner is swappable via `setRlmSpawnOverride` (test seam).

## Limits

| Limit | Value |
| ----- | ----- |
| `rlm` name length | 64 chars |
| `agent_message` message size | 16 KiB |
| Pending messages per mailbox | 20 |
| Family reach | parent, direct children (siblings arrive in a later phase) |

## Scope (first slice)

- ✅ `rlm()` admission + spawn handle
- ✅ `rlm.list_subagents()` / `rlm.delete_subagent()`
- ✅ `agent_message.list_agents()` / `send()` / `recv()`
- ✅ in-memory family registry + mailboxes, spawn-seam tests
- ⏳ child kernels wired into the family (child `recv` drains its mailbox)
- ⏳ siblings reach, `find_models` catalog, compaction-surviving persistence
- ⏳ `/refine` continual harness and daemon/attach layer (separate phases)

## Tests

- `test/eval/py/rlm.test.ts` — Node-side bridge semantics (admission, registry
  settlement, delete rules, roster, routing, reach errors, caps) through the
  spawn override seam.
- `test/eval/py/prelude.test.ts` — Python-side helpers build the exact bridge
  payloads the host expects.
