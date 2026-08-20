# RLM Kernel Spike — Report & Decision

**Phase 1 · 2026-08-17 · Status: PASSED — decision recorded (adapt, do not transplant)**

---

## 1. Purpose

Before porting any RLM machinery from prime-agent, prove that an RLM-style turn
can run on omp's existing `eval` Python kernel:

```
persistent Python cell → host request → tool call → result → next cell
```

If the existing kernel already provides the execution substrate, Phase 2 can
focus on the *RLM semantics* (recursive subagents, `/refine`, daemon) instead of
re-transplanting kernel infrastructure.

## 2. What was tested

Runnable prototype: **`scripts/rlm-spike.ts`** (`bun scripts/rlm-spike.ts`).

It drives the **real production path** — `executePython` → NDJSON runner
subprocess → HTTP loopback tool bridge — with a minimal `ToolSession` whose fake
tools use the real filesystem and shell. Six cells:

| # | Cell | Proves |
|---|---|---|
| 1 | Python state setup (`task_ctx`, `total`) | kernel boots, state created |
| 2 | `read("sample.txt")` (prelude helper) | host request: kernel → bridge → host tool → real file read |
| 3 | `tool.bash(command="echo …$((40+2))")` (proxy) | kernel can call **any** host tool by name |
| 4 | reuse `task_ctx`/`total` from cell 1 | state persists across cells (kernel reuse) |
| 5 | `write("out.txt", …)` then `read("out.txt")` | full round trip through the bridge |
| 6 | `%%bash` magic | shell cells in the same persistent session |

## 3. Results

```
PASS  1. python state setup               → total: 8
PASS  2. prelude read() via host bridge   → first line: hello from the RLM spike
PASS  3. tool.bash proxy via host bridge  → bash result: bridge-works-42
PASS  4. state persisted across cells     → persisted: True
PASS  5. write()/read() round trip        → read back: written by the RLM spike
PASS  6. %%bash magic                     → magic-works-2
```

All five spike checks green; process exits cleanly.

## 4. How the RLM execution model maps onto omp today

| RLM concept (prime-agent) | omp mechanism (existing, verified) |
|---|---|
| Persistent IPython kernel as the model-facing surface | `eval` Python kernel: retained subprocess, NDJSON frames, state persists per session (`kernelMode: "session"`) |
| Typed host requests (kernel → host operations) | HTTP loopback tool bridge (`src/eval/py/tool-bridge.ts`) + prelude helpers (`read`, `write`, `env`, `output`, …) |
| Model calls host tools | `tool.<name>(args|kwargs)` proxy — resolves **any** registered tool via `session.getToolByName` |
| Recursive subagents (`rlm(...)`) | `agent(prompt=…, schema=…, isolated=…, handle=…)` helper → `runStructuredSubagent` (Phase 2: align semantics, add `agent_message`) |
| Model-driven completions | `completion(prompt, model=…)` prelude helper → `__completion__` bridge (needs a model-configured session) |
| `%%bash` cells | supported by the runner's magic line-scanner |
| Rich display / MIME bundles | `display()` with `_repr_*_` fallbacks (pandas/PIL/plotly) |

**Key structural difference:** prime-agent boots a real **ipykernel** (ZeroMQ,
managed venv, `prime-agent-runtime` shim installed into the kernel env). omp's
runner is **self-contained** (stdlib-only, no IPython dependency, no extra pip
packages) and reaches host tools over loopback HTTP instead of ZeroMQ host
requests. That is a *simpler, more portable* substrate — not a missing one.

## 5. Gap analysis — what Phase 2 must still build

The kernel substrate is proven; the *RLM layer* on top is not yet there:

1. **`rlm()` admission semantics** — async child spawn returning an admission
   handle, parent-scoped child registry surviving compaction, `agent_message`
   delivery modes (auto/steer/follow_up). omp's `agent()` is synchronous with
   structured output; the RLM model needs the async handle + registry layer
   (port `rlm-runtime.ts`, `agent-messages.ts` concepts onto `task`/`hub` infra).
2. **`/refine` continual harness** — snapshot/rollback of supplemental harness
   state (port `core/refinement/`, layered on omp memory backends).
3. **Python-backed skills** — skills as importable packages installed into the
   kernel env (omp has markdown managed skills; needs the package-install path).
4. **"ipython as the model tool" prompt/loop design** — RLM makes the Python
   cell the *primary* model surface; today `eval` is one of 31 tools. The RLM
   prompt + loop wiring is a coding-agent layer, not a kernel change.
5. **Daemon/attach + schedules/heartbeats/autonomous** — Phase 5, unchanged.

Not needed: ZeroMQ transport, ipykernel bootstrap/venv management,
`prime-agent-runtime` shim, kernel host-request protocol. The existing runner +
bridge covers the execution contract.

## 6. Decision

**ADAPT, do not transplant.** Build the RLM layer on omp's existing `eval`
kernel and loopback bridge. Rationale:

- The execution contract (persistent state, host requests, arbitrary tool
  calls, shell cells) is already satisfied and now *verified end-to-end*.
- Avoiding ipykernel/ZeroMQ removes a venv-managed Python dependency and a
  second wire protocol.
- The porting effort moves entirely to the RLM *semantics* layer, which is
  where omp's `task`/`hub`/memory infra already provides strong anchors.

## 7. Notes & risks

- The spike used fake tools over real fs/shell; production sessions register the
  real tool registry (`getToolByName`) — covered by omp's existing eval tests.
- `completion()` and `agent()` need a model-configured session; Phase 2 will
  validate them against the real agent-session path.
- Kernel addon requirement for local runs: prebuilt `pi_natives.*.node` files in
  `packages/natives/native/` (from the upstream npm leaf; gitignored).
