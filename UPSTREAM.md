# Upstream Sync Log

`scripts/upstream-sync.ts` + `.github/workflows/upstream-sync.yml` keep omp in
lockstep with its upstreams. This file records the last-synced commit per lane;
the sync workflow updates it automatically.

## Lane A — oh-my-pi (base)

- **Sync point:** `72000ac` (2026-08-20) — lane A (oh-my-pi)

The base tree is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
(MIT, © Mario Zechner, © Can Bölük), itself a fork of
[Pi](https://github.com/badlogic/pi-mono) by Mario Zechner. Every sync merges
`can1357/oh-my-pi/main` into a `sync/upstream-omp-<date>` branch; conflicting
hunks resolve with `-X ours` (keep omp's rebranded lines) and the branding
guard (`scripts/check-branding.ts`) is the enforcement backstop.

## Lane B — prime-agent (RLM layer)

- **Sync point:** none yet — the RLM port lands in Phase 1-2 of [PLAN.md](PLAN.md).

Selected RLM modules are ported from
[PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
(MIT, © Mario Zechner, © Prime Intellect) via reviewed patch ranges. The
module list lives in PLAN.md §3.3. `prime-inference-*` modules and all
PrimeIntellect branding are excluded by design.
