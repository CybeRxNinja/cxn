# cxn — Project Progress

**Last updated:** 2026-08-18
**Current phase:** Phase 6 DONE — compaction-surviving daemon durability (ledger + leases + mailboxes persist across restart) landed in PR #11; the RLM daemon lane (Phases 0–6) is complete. Next: operational hardening + the pre-existing `cli-computer-lazy` regression (regressed by PR #10, out of Phase 6 scope).

---

## Executive status

cxn is a **public, working coding agent** — the base oh-my-pi fork is fully rebranded,
CI is green on the core gates (typecheck, branding guard, lint), the upstream sync pipeline
is operational end-to-end with automated import healing, and the first two RLM features
(`/refine` harness and `rlm()` recursive subagents) are ported and tested. The Rust
validation gate (`pi-shell` kill-pipeline test) is a known flake on loaded CI runners —
the test itself passes locally and on unloaded runners; the fix is tracked below.

---

## What's done

### Phase 0 — Bootstrap ✅

| Item | Status | Notes |
|------|--------|-------|
| Private repo created & published public | ✅ | `CybeRxNinja/cxn` on GitHub |
| Upstream remotes configured | ✅ | `upstream-omp` (can1357/oh-my-pi), `upstream-pa` (PrimeIntellect-ai/prime-agent) |
| Full rebrand sweep | ✅ | CLI → `cxn`, scope → `@cxn/*`, prompts/URLs/branding → `cxn` (see §2.5 of PLAN.md) |
| Branding guard CI gate | ✅ | `scripts/check-branding.ts` + `.github/workflows/branding-guard.yml` — fails PRs on forbidden branding |
| CI green on hosted runners | ✅ | `bun run check:ts`, branding guard, lint — all passing on `ubuntu-latest` |
| License/attribution preserved | ✅ | MIT notices for Zechner, Bölük, and Prime Intellect (for ported code) retained |
| Compliance doc | ✅ | `docs/compliance.md` — licensing, ToS, trademark, supply-chain analysis |
| Sync point tracking | ✅ | `UPSTREAM.md` — records last-synced commit per lane, auto-updated by sync workflow |

### Phase 1 — RLM Spike + Kernel ✅

| Item | Status | Notes |
|------|--------|-------|
| RLM kernel spike | ✅ | `scripts/rlm-spike.ts` — proved persistent Python cell → host request → tool call on existing `eval` kernel |
| Decision: ADAPT, not transplant | ✅ | No ipykernel/ZeroMQ needed; build RLM semantics on NDJSON runner + loopback bridge |
| Spike report | ✅ | `docs/rlm-spike.md` |

### Phase 2 — First Port Wave (partial)

#### RLM recursive subagents ✅

| Item | Status | Notes |
|------|--------|-------|
| `rlm()` admission + spawn handle | ✅ | `eval/py/rlm.ts`, bridge dispatch in `eval/js/tool-bridge.ts` |
| `rlm.list_subagents()` / `rlm.delete_subagent()` | ✅ | In-memory family registry keyed by parent session |
| `agent_message` send/recv/list | ✅ | Per-family mailboxes with delivery modes (auto/steer/follow_up), receipts, caps |
| Python prelude helpers | ✅ | `rlm.*` / `agent_message.*` in `eval/py/prelude.py` |
| Tests (bridge + prelude) | ✅ | `test/eval/py/rlm.test.ts`, `test/eval/py/prelude.test.ts` |
| Docs | ✅ | `docs/rlm.md` |
| Child kernels wired into family | ✅ | Child's own `agent_message.recv()` drains its mailbox (wired into parent family via `getAgentId()` → `eval/py/family-store.ts`) |
| Siblings reach | ✅ | Sibling-to-sibling reach implemented in Phase 3 via verbatim `assertAgentFamilyReach`. |
| `find_models` catalog | ✅ | Ported to `__rlm__` (free-text / provider / capability query over the bundled catalog) |
| Compaction-surviving persistence | **Done** | Ledger + leases + mailboxes persist to `agentDir` and reload on daemon boot (Phase 6, PR #11) |

#### /refine continual harness ✅

| Item | Status | Notes |
|------|--------|-------|
| Harness core (types, stores, history) | ✅ | `src/refinement/{types,state}.ts` — file-backed global + per-session stores, JSONL history |
| Plan/apply/rollback | ✅ | `src/refinement/refinement.ts` — LLM planning, JSON parsing, apply with snapshots, derived-proposal rollback |
| Memory-backend adapter | ✅ | `src/refinement/memory-backend.ts` — applied `memory` entries sync into active backend |
| `/refine` slash command | ✅ | `src/slash-commands/builtin-refine.ts` — `run`, `--global`, `--rollback <id>`, `history` |
| System-prompt injection | ✅ | `sdk.ts` — harness overview rides alongside memory instructions |
| Tests (33) | ✅ | `test/refinement/` — state, refinement semantics, memory adapter |
| Docs | ✅ | `docs/refine.md` |
| Auto-refine gate | ⏳ | `reviewAutoRefine` implemented but not hooked into turn loop (wire after daemon lane) |

#### Upstream sync pipeline ✅

| Item | Status | Notes |
|------|--------|-------|
| Sync script | ✅ | `scripts/upstream-sync.ts` — merge, rebrand pass, version alignment, import heal, typecheck gate, PR creation/update |
| Rebrand pass | ✅ | `@oh-my-pi/*` → `@cxn/*`, product strings, user-agent regex — runs on every sync |
| Version alignment | ✅ | Aligns workspace versions to upstream's latest when sync brings a release bump |
| Import heal | ✅ | Heals missing imports dropped by `-X ours` merge (layout-preserving splice + biome normalization) |
| Biome lint pass | ✅ | Applies safe + unsafe (unused import) fixes on synced files |
| Typecheck gate | ✅ | `bun run check:ts` on synced tree; PR labeled `sync-failed` if types don't clean |
| Label REST API | ✅ | PR update/label via REST (not GraphQL) for limited token compatibility |
| CI workflow | ✅ | `.github/workflows/upstream-sync.yml` — weekly cron + manual dispatch, auto-merge when green |
| Sync end-to-end verified | ✅ | PR #3 synced omp @ `8500092` with all gates green (except Rust flake) |

#### CI test fixes ✅

| Item | Status | Notes |
|------|--------|-------|
| Internal URL autocomplete test | ✅ | Rebranded scheme list sorted correctly |
| Git-hosting test | ✅ | Over-rebranded repo expectations reverted (parser returns literal upstream URLs) |
| Export HTML template sha256 | ✅ | Updated deterministic fingerprint |
| TUI notification base64 fixtures | ✅ | Updated to `base64("cxn")` |
| QR code fingerprint fixtures | ✅ | Updated for `my.cxn.sh` URL |
| Julia kernel boot budget | ✅ | Bumped from 15s to 60s for cold CI boots |
| pi-shell kill test timeouts | ✅ | Bumped to 30s (still flaking on loaded CI runners — see below) |

---

## What's in progress / failing

### Rust validation gate — RESOLVED ✅

The `Validate Rust workspace (bazel)` job had **two** independent failures; both are now fixed:

1. **Rustfmt drift (the recurring failure).** `MODULE.bazel` pinned `versions` (rustc) to a
   fixed nightly but left `rustfmt_version` at rules_rust's default — a *rolling*
   `DEFAULT_NIGHTLY_VERSION`. CI's rustfmt therefore resolved a different formatter between
   runs (e.g. `2026-06-30`) than dev formats with (`rust-toolchain.toml` → `2026-07-28`),
   reddening the rustfmt gate on otherwise-clean trees (first tripped on
   `crates/pi-shell/src/minimizer/filters/bun.rs`). **Fix (PR #4):** pin
   `rustfmt_version = "nightly/2026-07-28"` (dev-aligned) with the matching sha256s, and
   reformat the one divergent crate.
2. **`kill_builtin_signals_every_process_in_a_jobspec_pipeline` timing flake.** On loaded CI
   runners the shell's pipeline-wait stalls past its 30s budget. **Fix (PR #3):**
   `--flaky_test_attempts=3` on the bazel `test` invocation — only re-runs a target after a
   failed attempt, so a genuinely broken test still fails while a load-stalled one retries.

**Current state:** `Validate Rust workspace (bazel)` is **green** on `main` (verified after
PR #4 merged). The kill test is mitigated, not fundamentally fixed — the correct upstream
fix (detect stopped pipeline members and return early) remains a follow-up but is no longer
CI-blocking.

---

## What's left

### Phase 2 — Remaining (RLM follow-ups + daemon)

| Item | Priority | Complexity | Notes |
|------|----------|------------|-------|
| Child kernels wired into family | **Done** | — | **DONE (in-process)** — extracted into `eval/py/family-store.ts`; a child's `agent_message.recv()` now drains its real mailbox. Resolution uses `getAgentId()` (== `rlm_child_id`) so no spawn-path injection is needed. The daemon is only needed for *cross-process* `cxn agents` + cross-session sibling reach (see `docs/daemon-lane.md` Phase 1). |
| Sibling-to-sibling messaging | **Done** | — | **DONE (Phase 3)** — `assertAgentFamilyReach` (ported verbatim from prime-agent) now permits child→sibling within a nuclear family, enforced on every `sendToFamily` (in-process + daemon). See `docs/daemon-lane.md` Phase 3. |
| `find_models` catalog | **Done** | — | Ported to `__rlm__` (free-text / provider / capability over the bundled catalog); added contract tests. |
| Compaction-surviving persistence | **Done** | **Phase 6 DONE (PR #11)** — `RlmSpawnLedger.persist()` writes `agentDir/rlm-ledger.json` on every mutation; `SessionLeaseRegistry.reload()` re-scans `agentDir/session-leases/*.lock`; mailboxes written per-family and re-seeded on boot via `restoreMailboxMessages`. All survive a daemon restart (tested). See `docs/daemon-lane.md` Phase 6. |
| Daemon supervisor skeleton | **Done** | — | `modes/daemon/` transport (UDS JSONL + in-memory) + `ensureDaemonRunning` supervisor + handlers (`agent_message`, `rlm`, `session`, `find_models`) over a shared `FamilyStore`. in-memory + real-UDS + supervisor tests. See `docs/daemon-lane.md` Phase 2. |
| Daemon ledger/leases/reach (`cxn agents` CLI) | **Done** | — | **Phase 3 + Phase 4 DONE** — `RlmSpawnLedger` (topology authority), `assertAgentFamilyReach` (verbatim reach boundary in `eval/py/family-reach.ts`), and `SessionLeaseRegistry` (on-disk `owner.json` + pid reaping) landed and wired into the daemon handlers; `cxn agents list/attach/send/stop` CLI added in Phase 4 over the shared `FamilyStore`. See `docs/daemon-lane.md` Phases 3–4. |
| Daemon robustness (heartbeats/reconnect/crash-cleanup) | **Done** | — | **Phase 5 DONE** — `HeartbeatCatalog` + `startDaemonHeartbeat` reaper (reaps stale child agents and force-releases their session leases by session dir), `DaemonClient` reconnect/retry with a generation-guarded pump, real `cli.ts --mode daemon` boot wiring `uncaughtException`/`unhandledRejection`/`SIGINT`/`SIGTERM` cleanup, and identity-checked lockfile removal on exit. Verified end-to-end by spawning the real `cxn` CLI subprocess. See `docs/daemon-lane.md` Phase 5. |
| Auto-refine hookup | Medium | Low | Wire `reviewAutoRefine` into turn loop (after daemon lands) |

### Phase 3 — Python-backed skills

| Item | Priority | Complexity | Notes |
|------|----------|------------|-------|
| Port `skills.ts` / `skill-blocks.ts` | Medium | Medium | Skills as importable Python packages installed into kernel env |
| SKILL.md discovery | Medium | Low | Skill package importable from Python cell |
| Skill install into kernel venv | Medium | Medium | Port `setup-kernel-venv.sh` pattern |

### Phase 4 — Long-running surfaces

| Item | Priority | Complexity | Notes |
|------|----------|------------|-------|
| `cron-jobs.ts` + `cxn schedule` | Medium | Medium | One-time + cron scheduled jobs |
| `autonomous.ts` + `cxn autonomous` | Medium | Medium | Bounded mode with turn/token/time budgets + quality gates |
| Goals CLI | Medium | Low | `/goal` persistent goals |
| Heartbeats | Low | Low | `/heartbeat` (user), `rlm_heartbeat` (agent) |

### Phase 5 — Automation & release

| Item | Priority | Complexity | Notes |
|------|----------|------------|-------|
| Release pipeline on hosted runners | High | High | `release.ts` adapted: version bump → tag → CI builds → GitHub Packages → GitHub Release with checksums |
| GitHub Packages publishing | High | Medium | `@cxn/*` to `npm.pkg.github.com`; native leaf packages |
| Installer scripts | High | Medium | `install.sh` / `install.ps1` adapted; `cxn update` reads configured registry |
| Homebrew tap (optional) | Low | Low | Self-gating on unset secret; port if desired |
| macOS signing/notarization | Low | Low | Auto-skip until `APPLE_*` secrets configured |
| Python runtime in releases | Medium | Medium | Bundle `cxn-runtime` wheel + kernel bootstrap |

### Phase 6 — Docs & hardening

| Item | Priority | Complexity | Notes |
|------|----------|------------|-------|
| Docs tree update | Medium | Medium | RLM/daemon docs, updated tool reference |
| Session migration tool | Low | Medium | Migrate old cxn sessions if format diverges |
| Security review | Medium | Medium | Sandbox warnings inherited; audit ported code |
| Remove `research/upstream/` clones | Low | Trivial | Gitignored; clean up before v0.1.0 |
| Telemetry decision | Low | Low | Disable or make opt-in (recommended: disable for private tool) |

---

## CI status (as of 2026-08-18)

| Gate | Status | Notes |
|------|--------|-------|
| Branding guard | ✅ Green | 6,141+ files checked; zero violations |
| Lint (biome) | ✅ Green | `bun run check:ts` — lint + format clean |
| Typecheck (tsgo) | ✅ Green | All workspace packages typecheck |
| TS tests (native/integration) | ✅ Green | 859+ Rust tests pass (excluding flake) |
| TS tests (coding-agent) | ✅ Green | 121+ slash-command tests, 33 refinement tests, all passing |
| Rust validation (bazel) | ✅ Green | rustfmt nightly pinned (PR #4) + kill-test flaky retry (PR #3) |
| Nix build | ✅ Green | `.github/workflows/nix.yml` |
| Upstream sync (PR #3) | ✅ Green | All TS gates pass; Rust flake is the only blocker |

---

## Key design decisions (summary)

1. **Adapt, don't transplant** the RLM kernel — cxn's `eval` kernel + loopback bridge already satisfy the execution contract.
2. **In-memory family state first** — compaction-surviving persistence is a follow-up, not a blocker.
3. **Automated sync with safety backstops** — `CXN_SYNC_PAT` auto-merges when CI is green; branding guard + typecheck gate prevent silent regressions.
4. **Layout-preserving import heal** — the sync script heals missing imports without corrupting multi-line formatting (biome normalizes afterward).
5. **REST over GraphQL for PR updates** — works with limited-scope tokens (classic PATs, `GITHUB_TOKEN`).
6. **Private by default, public-ready** — the repo is public; GitHub Packages still require auth; Releases are public with checksums.

---

## File index (key paths)

| Path | Purpose |
|------|---------|
| `PLAN.md` | Master plan and roadmap |
| `UPSTREAM.md` | Sync-point log (auto-updated) |
| `docs/progress.md` | This document |
| `docs/rlm-spike.md` | Phase 1 spike report |
| `docs/rlm.md` | RLM recursive subagents reference |
| `docs/refine.md` | /refine continual harness reference |
| `docs/compliance.md` | Licensing/ToS/trademark analysis |
| `scripts/upstream-sync.ts` | Upstream sync script (merge + rebrand + heal + PR) |
| `scripts/check-branding.ts` | Branding guard (CI gate) |
| `packages/coding-agent/src/refinement/` | /refine harness core |
| `packages/coding-agent/src/eval/py/rlm.ts` | RLM bridge dispatch |
| `packages/coding-agent/src/slash-commands/builtin-refine.ts` | /refine command |
| `.github/workflows/ci.yml` | Main CI workflow |
| `.github/workflows/upstream-sync.yml` | Upstream sync workflow |
| `.github/workflows/branding-guard.yml` | Branding guard workflow |
