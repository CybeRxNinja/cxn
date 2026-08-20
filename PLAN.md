# omp — Research & Implementation Plan

**Status:** Phase 2 in progress — rlm() + /refine + upstream sync landed; daemon lane next
**Date:** 2026-08-18 (updated)
**Goal:** Build a private coding agent **`omp`** on top of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) that keeps **all** omp features, adds **prime-agent-like capabilities** (RLM runtime, recursive subagents, continual harness, daemon-backed long-running sessions), removes **all PrimeIntellect-ai branding/affiliations**, and ships with **automated upstream-sync + release workflows** in a private GitHub repo.

---

## 1. Executive Summary

`omp` = **omp (base + all features)** ⊕ **prime-agent RLM layer (ported, rebranded)** − **all third-party branding** + **automation (upstream sync, CI, releases)**.

| Pillar | Source | What we do |
|---|---|---|
| Base codebase | `can1357/oh-my-pi` (MIT) | Fork as the foundation; keep every feature |
| New capabilities | `PrimeIntellect-ai/prime-agent` (MIT) | Port the RLM runtime, `rlm()` subagents, `/refine` harness, daemon + long-running features |
| Branding | both | Full rebrand to `omp`; strip PrimeIntellect marketing/affiliations; keep legally-required MIT attributions |
| Automation | omp's own scripts + workflows | Adapt `release.ts`, `ci.yml`, binary/checksum/brew pipeline to a **private** repo on GitHub-hosted runners |

**Critical verified finding:** omp contains **zero** PrimeIntellect references (verified by grep across the whole tree). The "PrimeIntellect advertisements and affiliations" only exist in prime-agent itself. So "removing PrimeIntellect branding" is a task that applies to the *ported code*, not to omp. omp's only attribution is to Mario Zechner's `pi` (and Can Bölük) — which we keep, because MIT **requires** preserving copyright notices.

---

## 2. Research Findings (documented evidence)

### 2.1 Lineage & provenance (verified via GitHub API + code inspection)

```
earendil-works/pi  (formerly badlogic/pi-mono)   — Mario Zechner's agent toolkit, MIT, ~92k★
   │
   ├── PrimeIntellect-ai/prime-agent             — hard fork + RLM harness, MIT, ~16.8k★
   │      "Our agent and TUI is built on top of pi" (README)
   │      LICENSE: "Copyright (c) 2025 Mario Zechner / Copyright (c) 2026 Prime Intellect"
   │      packages: @earendil-works/pi-{ai,agent,tui,coding-agent} (inherited names), public pkg "prime-agent"
   │      version 0.7.2 · npm workspaces · Node ≥22 · no Rust
   │
   └── can1357/oh-my-pi  ("omp")                 — coding-first rewrite, MIT, ~25.4k★
          "Fork of Pi by @mariozechner" (README)
          LICENSE: "Copyright (c) 2025 Mario Zechner / Copyright (c) 2025-2026 Can Bölük"
          packages: @cyberxninja-omp/pi-{ai,agent,tui,coding-agent,natives,...}, CLI `omp`
          version 17.3.5 · Bun workspaces + Bazel + ~80k lines Rust core · N-API addon
```

- Both are **siblings**, not parent/child. omp is *not* a fork of prime-agent.
- Both are **MIT**. MIT requires retaining the copyright notice of the original authors in redistributed copies — this includes the "Copyright (c) 2026 Prime Intellect" line for any code we port from prime-agent. We may strip *logos, marketing copy, URLs, product names, telemetry endpoints* — but not the copyright notice.

### 2.2 omp feature inventory (KEEP — this is the base)

Verified from README, docs/, DEVELOPMENT.md, package.json:

- **Tool surface (31 tools):** `read` (files/dirs/archives/SQLite/PDFs/notebooks/URLs/ssh://internal schemes), `write`, `edit` (hashline content-hash anchors), `ast_edit`/`ast_grep`, `grep`, `glob`, `bash` (in-process coreutils, PTY, background jobs), `eval` (persistent Python/JS/Ruby/Julia cells, tool re-entry via loopback bridge), `lsp` (14 ops), `debug` (DAP, 28 ops), `security_scan`, `task` (fan-out subagents, isolated worktrees, schema-validated results), `hub` (live agent messaging/supervision), `todo`, `ask`, `browser` (Puppeteer/CDP/relay), `computer` (desktop control), `web_search` (23-provider chain + site-aware extraction), `github`, `generate_image`, `inspect_image`, `tts`, memory tools (`checkpoint`, `rewind`, `retain`, `recall`, `reflect`, `memory_edit`, `learn`, `manage_skill`).
- **Code intelligence:** LSP wired into every write (`workspace/willRenameFiles`), real debugger driving (lldb/dlv/debugpy).
- **Subagents:** `task` fan-out with Agent Hub (`omp agents`), `hub`, IRC, `swarm`, `vibe-mode`.
- **Memory:** 3 backends (local / Hindsight / Mnemopi), project-scoped, `retain`/`recall`/`reflect`/`learn`.
- **Session model:** JSONL sessions, snapcompact, `--resume`, session tree, export/share/fork (`/collab`), `conflict://` resolution.
- **Rules/context:** imports Cursor MDC, Cline .clinerules, Codex AGENTS.md, Copilot applyTo; time-traveling stream rules (TT-SR); magic keywords (`ultrathink`, `orchestrate`, `workflowz`).
- **Providers:** 60+ providers / 1000+ models, 10 model roles, fallback chains, path-scoped models, round-robin credentials, custom OpenAI-compatible providers.
- **Platform:** same binary on macOS/Linux/Windows; Rust natives in-process (ripgrep/glob/find/brush-shell); Nix flake; ACP mode; collab relay; browser-relay extension.
- **Release/distribution:** `bun build --compile` binaries for 7 targets (darwin-arm64/x64, linux-x64/arm64, musl variants, win32-x64), bazel-built `pi_natives.<tag>.node` addons published as `@cyberxninja-omp/pi-natives-<tag>` leaves, GitHub Release with changelog notes + `SHA256SUMS.txt` + browser-relay zip, Homebrew tap, npm publish (OIDC trusted publishing), install.sh/install.ps1, `omp update`.

### 2.3 prime-agent feature inventory (PORT candidates)

Verified from docs (index, architecture, rlm, daemon, long-running-agents, rlm-runtime) and src tree:

1. **RLM runtime** — persistent **IPython kernel (ZeroMQ)** as the model-facing control environment; `ipython` is the *only* built-in model tool; typed "host requests" let the kernel call back into the TypeScript host (file ops, tools, subagents); Python state survives turns and compaction; `%%bash` cells; `rlm()` preloaded callable.
2. **Recursive subagents** — `await rlm("task", name=...)` returns an admission handle immediately; children are real `AgentSession`s with their own context; results via `agent_message.send(...)`; parent-scoped child registry survives compaction/restart; configurable recursion depth.
3. **Continual Harness `/refine`** — reviews the trajectory and applies small, evidence-backed updates to *supplemental* harness state (prompts, memories, skill descriptions, subagent specs); base system prompt immutable; snapshots support rollback; refinement history recorded.
4. **Python-backed skills** — `SKILL.md` + importable Python package installed into the kernel env; model calls `await my_skill(...)`; superset of the Agent Skills markdown format.
5. **Daemon architecture** — detached supervisor + catalog subprocess + one resident worker process per root session tree; JSONL-framed public daemon protocol v4 (versioned envelopes, generation-aware event cursors, snapshots, reconnect/replay); session leases; crash recovery (250ms/1s/5s retries); `prime-agent agents|attach|list|stop|status|doctor|shutdown`.
6. **Agent-to-agent messaging** — `agent_message` skill (`list_agents`, `send`, delivery modes auto/steer/follow_up, receipts), `prime-agent send <agent> <msg>`.
7. **Long-running surfaces** — `/heartbeat` (user), `rlm_heartbeat` (agent), `prime-agent schedule` (one-time + cron, per-session `scheduled-jobs.json`), `/goal` persistent goals, `/autonomous` bounded mode (turn/token/time budgets + user-defined quality gates), automatic compaction.
8. **Runtime shim** — `prime-agent-runtime` Python package (`ipykernel`, `nest-asyncio`, `tyro`), installed via uv/venv; kernel bootstrap CLI.

### 2.4 Gap analysis — omp vs prime-agent (what to actually port)

| Capability | omp today | prime-agent | Action |
|---|---|---|---|
| Persistent Python kernel | `eval` tool: retained subprocess kernel, NDJSON, tool re-entry via `agent-bridge.ts` | IPython kernel as *primary* model surface, ZeroMQ transport, host requests | **Adapt**: upgrade/extend omp's `src/eval/py/` into the RLM control surface instead of transplanting prime-agent's ZeroMQ stack wholesale (see §4.3) |
| Recursive subagents | `task` fan-out (typed results, worktrees) | `rlm(...)` programmatic children + `agent_message` | **Port**: `rlm-runtime.ts`, `agent-messages.ts`, child registry; align with omp `task` infra |
| Continual harness /refine | `learn`/`retain`/autolearn (memory banks) | `/refine` snapshot+rollback harness | **Port**: `core/refinement/`, adapt to omp memory backends |
| Python-backed skills | managed skills (markdown) | skills as importable Python packages | **Port**: `skills.ts`/`skill-blocks.ts` + runtime install into kernel env |
| Daemon/supervisor | none (session-per-process; subagents in-process) | detached supervisor + resident workers + protocol v4 | **Port**: `modes/daemon/`, `agent-connection/`, session leases |
| Attach/detach | `--resume` (file-based) | live attach with replay snapshots | **Port** (daemon lane) |
| Schedules/cron | none | `schedule`, `cron-jobs.ts` | **Port**: `cron-jobs.ts` + CLI |
| Heartbeats | none | `/heartbeat`, `rlm_heartbeat` | **Port** |
| Goals | `src/goals/` exists (runtime/state/tools) | `/goal` persistent goals | **Verify overlap**, port CLI/persistence if needed |
| Autonomous mode | none | budgets + quality gates | **Port**: `autonomous.ts` |
| Session format | JSONL (snapcompact) | JSONL | **Converge**: keep omp's session store; map RLM entries |
| Agent messaging | `hub`/IRC (subagent-level) | cross-session `agent_message` | **Port/merge** into `hub` |

**Conclusion:** omp already covers ~40–50% of the RLM feature surface with different mechanisms (`eval`, `task`, `hub`, `goals`, memory). The honest strategy is **adapt-and-extend**, not wholesale transplant. Only the daemon layer, `/refine` harness, `rlm()` semantics, schedules/heartbeats/autonomous, and Python-package skills are genuinely new.

### 2.5 Branding & affiliation audit

**Verified: zero `primeintellect` / `prime-agent` / `Prime Intellect` matches in omp** (case-insensitive grep over `*.md *.ts *.rs *.json *.yml *.yaml *.toml *.sh`, excluding node_modules/.git).

Branding to strip **from ported prime-agent code** when it enters omp:

- README logo + `primeintellect.ai` links, "PRIME-RL" / "Verifiers" links, blog links
- Install URL `app.primeintellect.ai/prime-agent/install.sh`
- Product naming: `prime-agent` (CLI, package names, code identifiers, prompts, docs)
- `core/prime-inference-*.ts` — **Prime Intellect's own inference API integration; exclude entirely from the port** (this is the literal "affiliation")
- Installer screens ("Installing Prime Agent"), splash, telemetry identifiers

Also strip cxn-only branding in the fork (even though not PrimeIntellect): `omp` binary name, `@cyberxninja-omp/*` scope, `omp.sh` links/hero images/Discord, `~/.omp` paths, `omp` occurrences in prompts/system-prompt, `omp-stats`/`install-id` telemetry (decide policy, §9).

**Legal requirement (non-negotiable):** keep MIT copyright lines in `LICENSE`:
```
Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Prime Intellect   <- only if we ship ported prime-agent code
Copyright (c) 2026 <omp owner>
```

---

## 3. Target Architecture

### 3.1 Repo layout (omp monorepo — based on omp)

```
omp/  (private repo)
├── packages/
│   ├── agent/            # @cyberxninja-omp/agent-core — agent loop, session runtime (+ RLM port)
│   ├── ai/               # @cyberxninja-omp/ai — provider registry, toolconv (60+ providers)
│   ├── coding-agent/     # @cyberxninja-omp/coding-agent — CLI `omp`, modes, tools, daemon (+ RLM port)
│   ├── tui/              # @cyberxninja-omp/tui
│   ├── natives/          # @cyberxninja-omp/pi-natives — N-API addon (bazel-built)
│   ├── mnemopi/, hashline/, omptype/, utils/, catalog/, stats/, wire/, snapcompact/,
│   ├── collab-web/, browser-relay/, typescript-edit-benchmark/
├── crates/               # pi-ast, pi-builtins, pi-iso, pi-natives, pi-shell, pi-voice, pi-walker, vendor
├── python/
│   └── cxn-runtime/      # (renamed prime-agent-runtime) kernel-side shim: ipykernel, nest-asyncio, tyro
├── scripts/              # release.ts (renamed), ci-release-*, sync-versions, install.sh, install.ps1
├── .github/workflows/    # ci.yml, upstream-sync.yml, (release jobs inside ci.yml)
├── docs/                 # omp docs tree + new RLM/daemon docs
├── PLAN.md               # this document
└── UPSTREAM.md           # sync-point log (§5)
```

### 3.2 Naming / rebrand matrix

| Item | omp | prime-agent | omp |
|---|---|---|---|
| Repo | can1357/oh-my-pi | PrimeIntellect-ai/prime-agent | `<org>/omp` (private) |
| CLI binary | `omp` | `prime-agent` | `omp` |
| npm scope | `@cyberxninja-omp/*` | `@earendil-works/*` + `prime-agent` | `@cyberxninja-omp/*` |
| Config/data dir | `~/.omp` | `~/.prime-agent` | `~/.omp` |
| Installer | `curl omp.sh/install` | `app.primeintellect.ai/...` | `omp` install script served from our own domain/GitHub Releases |
| Self-update | `omp update` | `prime-agent update` | `omp update` |
| Python runtime pkg | — | `prime-agent-runtime` | `cxn-runtime` |
| Natives addon | `pi_natives.<tag>.node` | — | keep filename (binary format), rename if trivial |
| Session dirs | omp session store | prime-agent store | `~/.omp/sessions` (migrate/alias) |
| Slash commands | omp's set | `/refine /goal /heartbeat /autonomous ...` | union, cxn-branded prompts |

### 3.3 Feature-port strategy (adapt > transplant)

Prime-agent's RLM kernel machinery (ZeroMQ, `ipykernel`, `prime-agent-runtime`) vs omp's `eval` kernel (NDJSON subprocess, runner.py, prelude, agent-bridge). **Recommendation: adapt omp's `eval` kernel** — it already persists state, already lets the kernel call back into agent tools (`agent-bridge.ts`), and adds Ruby/Julia. Port prime-agent's *semantics* (host-request protocol surface, `rlm()` preload, admission handles, `agent_message`) as a new layer on top. Validate with a **Phase-1 spike** (§8) that runs an RLM-style turn (model → Python cell → host request → tool call) through the existing eval stack. If the spike shows fundamental blockers (e.g., need true Jupyter kernelspecs, `%magics` beyond what runner.py supports), fall back to transplanting prime-agent's `core/kernel/` + `prime-agent-runtime`.

Modules to port/cherry-pick from prime-agent (concrete paths, from code inspection):

```
packages/coding-agent/src/core/rlm-runtime.ts, rlm-max-depth.ts   → rlm() subagents
packages/coding-agent/src/core/agent-messages.ts                  → agent_message skill
packages/coding-agent/src/core/refinement/                        → /refine harness
packages/coding-agent/src/core/autonomous.ts, goals.ts, cron-jobs.ts → long-running
packages/coding-agent/src/core/skills.ts, skill-blocks.ts         → python-backed skills
packages/coding-agent/src/modes/daemon/, agent-connection/        → daemon supervisor + client
packages/coding-agent/src/core/agent-session-runtime.ts, agent-session*.ts → worker runtime
packages/coding-agent/src/core/kernel/                            → only if spike fails
prime-agent-runtime/                                              → python/cxn-runtime/
```

Explicitly **excluded** from the port: `core/prime-inference-*.ts`, Prime Intellect provider/auth modules, all prime-agent branding strings, all `app.primeintellect.ai` URLs, telemetry endpoints.

---

## 4. Upstream Sync Strategy (automated)

### 4.1 Two upstream lanes

| Lane | Upstream | What we take | Method |
|---|---|---|---|
| A — base | `can1357/oh-my-pi` | everything (fixes, features, tools) | `git merge` from a tracking branch, cadence ~weekly (or daily automated PR) |
| B — RLM | `PrimeIntellect-ai/prime-agent` | the RLM modules listed in §3.3 | **patch-queue / subtree**, reviewed cherry-picks only |

Why merge for A: omp keeps omp's directory layout and package names (rebranded), so a straight merge with conflict review is cleanest and matches omp's own `docs/porting-from-pi-mono.md` practice (they merge pi-mono with a documented "Last Sync Point"). Why patches for B: prime-agent's layout diverges (different package scope, different session format, different kernel stack); we only want specific files, so we generate `git format-patch` ranges from a pinned prime-agent commit and apply selectively.

### 4.2 Sync mechanics

```
remotes:
  origin          = <org>/omp (private)
  upstream-omp    = https://github.com/can1357/oh-my-pi.git
  upstream-pa     = https://github.com/PrimeIntellect-ai/prime-agent.git

per sync (lane A):
  1. git fetch upstream-omp
  2. git checkout -b sync/cxn-<date>
  3. git merge upstream-omp/main --no-commit  → resolve conflicts (rebrand-aware: keep @omp scope, omp names)
  4. run rebrand guard (see below) + bun run check + tests
  5. commit "chore: sync upstream omp @ <sha>" + update UPSTREAM.md sync point
  6. push → PR → CI gates → human merge
```

- **Rebrand guard script** (`scripts/check-branding.ts`): fails CI if `omp`, `omp`, `prime-agent`, `primeintellect`, `@mariozechner`, `@earendil-works`, `omp.sh`, `app.primeintellect.ai` appear in non-allowed files (allowlist: LICENSE attribution, changelog historical entries, docs referencing upstream). This makes "removing all PrimeIntellect advertisements" an enforced invariant, not a one-time task.
- **Conflict policy:** omp upstream rewrites the same `src/` we modify → expected conflicts. Resolution rule: prefer omp naming/features; re-apply rebrand guard after every resolve. Keep merges small & frequent (weekly) to keep conflict surface small. `git merge -X patience` and component-level merge tooling (e.g., `git imerge`-style) optional.
- **Sync-point log** (`UPSTREAM.md`): record last-synced commit + date per lane, mirroring omp's own `docs/porting-from-pi-mono.md` convention.

### 4.3 Automated sync workflow (`.github/workflows/upstream-sync.yml`)

```yaml
name: Upstream sync
on:
  schedule: [{ cron: "0 6 * * 1" }]      # weekly; also workflow_dispatch with lane input
  workflow_dispatch: { inputs: { lane: { type: choice, options: [omp, prime-agent, both] } } }
permissions: { contents: write, pull-requests: write }
jobs:
  sync-omp:
    - checkout omp main
    - git fetch upstream-omp + merge attempt (script scripts/upstream-sync.ts)
    - if clean → push to branch `sync/omp/<date>`, open PR "chore: sync upstream omp @ <sha>"
    - if conflicts → still open PR, list conflicting paths in PR body, add label `sync-conflicts`
  sync-prime-agent:
    - fetch upstream-pa, regenerate patch queue for pinned §3.3 paths (script scripts/port-rlm.ts)
    - open PR "chore: port rlm upstream @ <sha>" with applied patches
  gates: CI must pass (check, tests, branding guard) before merge allowed
```

**Decision (2026-08-17): fully automated sync.** Schedules run on the default branch; `GITHUB_TOKEN`-created PRs can't be merged by other workflow runs, so the sync workflow uses a **fine-grained PAT** (`CXN_SYNC_PAT`, scoped to `contents:write` + `pull-requests:write` on the omp repo only) to push the sync branch and auto-merge it **only when CI is green**. Safety: branch protection on `main` requires the CI status checks to pass before merge, so upstream breakage can never land silently — a failed sync just leaves the PR open with a `sync-conflicts` / `sync-failed` label for manual review.

---

## 5. Release Automation

Adapt omp's proven pipeline. omp release flow (verified): `bun scripts/release.ts <patch|minor|major>` → bump all package versions + sync-versions → fix changelogs → nix-bun regen → commit `chore: bump version to vX.Y.Z` + push tag atomically → CI detects release tag at HEAD (`release_metadata` job) → parallel binary builds → validation gate → GitHub Release (changelog notes + `SHA256SUMS.txt` + browser-relay zip) → npm publish (core + native leaves) → Homebrew tap → (optional macOS signing).

### 5.1 Changes for omp (private)

1. **Rename scripts:** `scripts/release.ts` → omp release script (`CXN_REPO`/`CXN_SCOPE` env-driven), `sync-versions.ts`, `fix-changelogs.ts`, `ci-release-{build-binaries,checksums,notes,publish}.ts`, `ci-update-brew-formula.ts` (drop brew tap unless desired).
2. **GitHub-hosted runners instead of self-hosted `cxn-kata`:** map jobs to `ubuntu-22.04`, `ubuntu-24.04-arm`, `macos-14` / `macos-15-intel` (verify availability for the org), `windows-latest`. Bazel remote cache → GitHub Actions cache (`.github/actions/bazel-cache` adapted to `actions/cache`); expect slower cold builds (mitigation §7).
3. **Package publishing — public npm registry (decided):** publish `@cyberxninja-omp/*` to the public npm registry using the repo's own `NODE_AUTH_TOKEN` (default `secrets.GITHUB_TOKEN`; falls back to a PAT only if publish-only scopes are needed). Native leaf packages `@cyberxninja-omp/pi-natives-<tag>` follow the same pattern. Consumers install `@cyberxninja-omp/*` from the public npm registry.
4. **GitHub Release — private (decided):** same pattern (tag `vX.Y.Z`, changelog-derived notes, binaries per target, `SHA256SUMS.txt`, browser-relay zip). Because Releases are private, installs of released binaries require auth: the installer accepts `CXN_INSTALL_TOKEN` (a PAT or GitHub App token) for authenticated downloads, documented in `scripts/install.sh`/`install.ps1` and the README.
5. **Installer:** adapt `scripts/install.sh` / `install.ps1` (REPO/scope vars → `omp`), self-update (`omp update`) reads the configured registry (npm public npm or GitHub Release assets).
6. **macOS signing/notarization:** keep the auto-skip behavior (no-op until `APPLE_*` secrets configured) — zero-cost optionality.
7. **Python runtime in releases:** bundle `cxn-runtime` wheel + kernel bootstrap (prime-agent's `setup-kernel-venv.sh` pattern) into the release asset list and installer.

### 5.2 Release pipeline (target workflow jobs)

```
release_metadata (detect v* tag at HEAD, derive version + prerelease channel)
 → check (tsc/lint/build web)
 → rust_validate (bazel test/clippy/rustfmt — non-PR only)
 → native_addons (bazel build pi_natives <tag>.node per platform)
 → test fan-out (workspace, singleton, native, UI, runtime, smoke, install-methods)
 → release_gate (all green)
 → release_binary / release_binary_darwin (bun compile per target, smoke, sign)
 → release_github (notes, checksums, GitHub Release)
 → release_github_verify (macOS codesign + smoke)
 → release_npm (public npm: core + native leaves)
 → release_brew (optional, only if tap exists)
```

---

## 6. CI Adaptation Notes

- omp's `ci.yml` is 907 lines and assumes the private `cxn-kata` self-hosted runner + GCS bazel cache. For omp: hosted runners, `actions/cache` for `~/.bun/install/cache` and bazel output base, drop the kata-only jobs/notices.
- Keep the concurrency design (release runs must not be cancelled by branch churn) — the `release-{sha}` group trick is important and portable.
- PR path for natives (fetch latest release addons from npm instead of building) is a good cost saver; with a private registry it still works via `NODE_AUTH_TOKEN`.
- Add the **branding guard** as a required check in branch protection.

---

## 7. Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **License/attribution violation** (stripping copyright lines) | Keep all MIT copyright notices (§2.5); only branding/marketing is removed; guard script enforces code-level hygiene, not license text |
| 2 | Fast-moving upstreams (omp releases ~weekly) | Weekly automated sync PRs; small frequent merges; sync-point log; `sync-conflicts` label workflow |
| 3 | RLM kernel transplant conflicts with omp's eval kernel | Phase-1 spike decides adapt-vs-transplant before committing (§3.3); keep `eval` as fallback surface |
| 4 | Hosted runners slower than `cxn-kata` (bazel cold builds) | `actions/cache` for bazel + bun; consider optional GCS/self-hosted later; increase timeouts |
| 5 | Private-repo install friction (auth for releases/npm) | Document tokens; public npm auth via `.npmrc`; installer reads `CXN_INSTALL_TOKEN`; optionally public Releases |
| 6 | Telemetry/privacy (omp install-id/stats, prime-agent telemetry) | Audit & disable or make opt-in; privacy matters for a private tool (§9 Q4) |
| 7 | Session-format divergence between omp JSONL and prime-agent JSONL | Keep omp's session store as canonical; add RLM entry types as extensions; migration tool for old omp sessions |
| 8 | `prime-inference-*` and other PI-specific integrations leaking into the port | Explicit exclusion list in port script + branding guard |

---

## 8. Roadmap (phases with exit criteria)

| Phase | Work | Exit criteria |
|---|---|---|
| **0. Bootstrap** ✅ | Repo created + published; upstream remotes; rebrand sweep; branding guard; CI green on hosted runners | `omp` binary builds & runs; zero forbidden-branding matches; CI green |
| **1. RLM spike + kernel** ✅ | Spike passed end-to-end ([docs/rlm-spike.md](docs/rlm-spike.md)); **Decision: ADAPT, do not transplant** — no ipykernel/ZeroMQ | Spike report written; decision recorded |
| **2. First port wave** 🔶 | **`rlm()` ✅** — admission, family registry, agent_message, tests ([docs/rlm.md](docs/rlm.md)). **`/refine` ✅** — harness core, snapshot/rollback, memory-backend adapter, 33 tests ([docs/refine.md](docs/refine.md)). **Upstream sync ✅** — automated merge + rebrand + heal + PR + typecheck gate. **Remaining:** child kernels in family, siblings, `find_models`, compaction-surviving persistence; **daemon/attach lane** (`modes/daemon/`, `agent-connection/`, session leases — `omp agents/attach/send/...`); auto-refine hookup | `rlm()` spawns children + messages flow; `/refine` applies + rolls back; daemon detach → worker survives → reattach with replay |
| **3. Python-backed skills** | Port `skills.ts`/`skill-blocks.ts`; install skills as importable packages into kernel env | Skill package importable from Python cell; SKILL.md discovery works |
| **4. Long-running surfaces** | `cron-jobs.ts`, `autonomous.ts`, goals CLI, heartbeats; `omp schedule/autonomous/goal/heartbeat` | Cron + goals + autonomous budgets run against daemon workers |
| **5. Automation** 🔶 | **Upstream sync ✅** (weekly + manual, auto-merge when green). **Remaining:** release pipeline on hosted runners (§5), public npm publishing, installer/self-update, branding guard as required check | A full release (tag → binaries → GitHub Release → npm) completes |
| **6. Docs & hardening** | omp docs tree; session migration tool; security review (sandbox warnings inherited); remove `research/upstream/` clones from repo | Docs complete; cleanup done; v0.1.0 shipped |

**Ordering rationale:** the daemon is the largest and most invasive piece, so it lands early (Phase 2) per the decided priority, but behind feature flags and after the Phase-1 kernel spike de-risks the RLM execution path. Phases 3–4 layer the remaining RLM features on top of the Phase-2 foundation.

---

## 9. Decisions (resolved 2026-08-17)

1. **npm publishing → public npm registry:** `@cyberxninja-omp/*` published to the public npm registry with `NPM_TOKEN`; consumers install from the public npm registry.
2. **GitHub Releases → private:** binaries + checksums private; installer downloads via `CXN_INSTALL_TOKEN`.
3. **Sync cadence → fully automated:** weekly + manual-trigger sync workflow using a fine-grained `CXN_SYNC_PAT`; auto-merge only when CI passes; failures surface as labeled PRs.
4. **Port priority → all three first:** `rlm()` recursive subagents, daemon/attach, and `/refine` all land in the first port wave (Phase 1), then Python-backed skills and the remaining long-running surfaces.

**Still open (defaults recommended):**
- **Telemetry:** disable omp install-id/stats + prime-agent telemetry entirely (recommended for a private tool) unless you want opt-in usage stats.
- Repo org/owner name for the private `omp` repo.
- macOS signing: skip until `APPLE_*` secrets are needed (workflow auto-skips).

---

## 10. Appendix — References & Verified Facts

- Upstream clones for reference: `research/upstream/omp` (tag/HEAD 17.3.5-era), `research/upstream/prime-agent` (0.7.2-era). Shallow clones; can be deleted before the repo goes live or kept under `research/` with `.gitignore` exclusions.
- omp docs that carry over: `docs/porting-from-pi-mono.md` (merge checklist template), `packages/coding-agent/DEVELOPMENT.md`, `docs/natives-*.md`, `docs/macos-signing-notarization.md`, `docs/session*.md`.
- prime-agent docs to adapt for omp: `packages/coding-agent/docs/{rlm,rlm-runtime,daemon,long-running-agents,architecture,skills,sessions,compaction}.md`.
- Verified commands used during research: `git clone --depth 1` × 2; `grep -rniE "primeintellect|prime-agent|prime agent"` (0 hits in omp); GitHub API `repos/{...}` parent/license/stars; file-level inventory of both `packages/`, `crates/`, `.github/workflows/`, `scripts/`.
