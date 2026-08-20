# /refine — continual harness

`/refine` is omp's continual-harness subsystem: it reviews the current
trajectory and applies small, evidence-backed edits to **supplemental** state —
prompt notes, memories, skill descriptions, and subagent specs — that persists
outside the token history. Every refinement records before/after snapshots of
the entries it touches, which is what makes **rollback** possible.

Ported from the /refine harness concept (MIT-licensed upstream), adapted to
omp's AI layer (`@cyberxninja-omp/pi-ai`) and memory backends
(`src/memory-backend/`).

## Command surface

```
/refine [instructions]      run a local refinement from the trajectory
/refine --global [instr]    run a global (cross-session) refinement
/refine --rollback <id>     roll back a previous refinement (snapshot restore)
/refine history             list prior refinements
```

- **Local** refinements write the current session's harness store; **global**
  refinements write the shared cross-session store. During a local refinement,
  global entries are read-only context (the model may not update/delete them).
- The base system prompt is immutable — only supplemental entries are editable
  (the model cannot target `base_system_prompt`).
- The harness overview is injected into the system prompt alongside the
  memory-backend instructions once the harness has content, so the model can
  route against persisted entries during normal turns.

## Architecture

| Module | Role |
|---|---|
| `src/refinement/types.ts` | Data model: entries, proposals, results, options |
| `src/refinement/state.ts` | File-backed stores (global + per-session), atomic saves, history JSONL, prompt formatting |
| `src/refinement/refinement.ts` | LLM planning, JSON parsing/validation, apply (with snapshots + baseline-conflict rejection), rollback, auto-review gate |
| `src/refinement/memory-backend.ts` | Adapter that syncs applied `memory` entries into the active memory backend |
| `src/slash-commands/builtin-refine.ts` | The `/refine` command |
| `src/sdk.ts` | Injects the harness overview into the system prompt |

### Stores

- **Global:** `<agentDir>/harness/harness_state.json` + `refinements.jsonl`
- **Local:** `<agentDir>/harness/local/<sessionId>/harness_state.json` + `refinements.jsonl`

State files are written atomically (temp file + rename, mode preserved) and a
corrupt store degrades to empty rather than breaking the session. Refinement
history is JSONL; rollback looks up a result by id and derives a reverse
proposal from its recorded snapshots.

### Snapshot / rollback

`applyRefinementProposal` records `before`/`after` per edit and bumps `version`
on updates. A rollback (`/refine --rollback <id>`) replays the applied edits in
reverse: deletes restore the prior entry, updates restore the prior content,
creates are deleted. A `baselineState` captured before the (slow) LLM pass
rejects edits to entries another session changed mid-flight, so a concurrent
global refine never silently clobbers unseen writes.

### Memory-backend integration

Applied `memory` entries are also saved into the active memory backend via its
`save()` (source `refine`), so refined facts become recallable through the
memory tool and feed the backend's consolidation pipeline. Rollback restores
the harness store (authoritative), but a copy already synced to the backend
persists — the backends are append-only by design (no generic per-entry delete),
mirroring how a `learn` lesson cannot be un-learned. With the `mnemopi` backend,
drop a stray copy with `memory_edit forget`; `/refine --rollback` prints this
note when it applies.

## Scope and follow-ups

- **Skills** are stored as routing hints with a python `reference`/`arguments`
  contract for the RLM kernel; installing them as real Python packages is the
  separate Python-backed skills track.
- **Subagents** are stored as delegation specs with the native
  `rlm()`/`agent_message` call contract (ported earlier).
- **Auto-refine** (turn-interval review gate) is implemented
  (`reviewAutoRefine`) but not yet hooked into the turn loop; wire it after the
  daemon lane lands so checkpoints run in the resident worker.
- `RefinementResult`s are recorded in each scope's JSONL history; they are not
  yet mirrored into the session transcript as custom entries.
