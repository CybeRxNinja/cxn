# Compliance posture

This document records the licensing and terms-of-service analysis for releasing
`CybeRxNinja/cxn` publicly. It is a point-in-time assessment (August 2026), not
legal advice; re-verify provider terms before relying on them, especially the
subscription-auth features in §3.

## 1. Licenses — all permissive

| Source | License | Evidence |
|---|---|---|
| oh-my-pi (base fork) | MIT (© Mario Zechner, © 2025-2026 Can Bölük) | Root `LICENSE` preserves both copyright lines; upstream is MIT per GitHub |
| prime-agent (RLM concept port) | MIT | We reimplemented the semantics rather than vendoring code; `docs/rlm.md` attributes the design |
| Vendored `crates/vendor/brush-core` | MIT (© reuben olinsky) | Dedicated `LICENSE` + patch notes in-tree |
| All Rust crates | MIT (`license.workspace = true`) | Root `Cargo.toml` |
| All npm/bun dependencies | MIT / Apache-2.0 / BSD / ISC | No GPL/AGPL/SSPL/Commons-Clause anywhere in the dependency tree |

MIT permits forking, rebranding, and closed-source redistribution provided the
copyright notice is preserved — which it is (root `LICENSE`, vendored-crate
notices, upstream URL attributions in README/docs).

## 2. No secrets or private artifacts in the tree

- Secret scan (tracked files): only fake test fixtures (`sk-ABCdef…` patterns,
  redaction tests) and `python/robomp/.env.example` (a template). No real keys.
- Native `.node` addons are gitignored (fetched at build/test time), not tracked.
- `research/` upstream clones are gitignored.
- CI secrets (`CXN_SYNC_PAT`, Apple signing keys) live in Actions secrets and
  are never exposed to fork PRs (workflows run with least-privilege
  `permissions:` blocks; the branding guard workflow is `contents: read`).

## 3. The one real flag: provider subscription-login features

The repo (inherited from oh-my-pi) ships OAuth login flows for consumer
subscriptions:

- **Claude Pro/Max** — `claude.ai/oauth/authorize` + `user:inference` scope and
  a `claude-code/*` bootstrap user-agent fingerprint
  (`packages/ai/src/registry/oauth/anthropic.ts`)
- **GitHub Copilot** — OAuth login (`packages/ai/src/registry/oauth/github-copilot.ts`)
- **ChatGPT/Codex** — OAuth + device flow (`packages/ai/src/registry/oauth/openai-codex.ts`)

**Status:** distributing the *code* is fine (MIT). *Using* these flows may
violate the providers' consumer terms — Anthropic explicitly prohibits
third-party tools routing requests through Free/Pro/Max credentials and has
actively enforced against such tools (2025-2026). End users bear that risk
(account bans, broken flows); the flows may also stop working at any time.
OpenAI and GitHub maintain similar restrictions.

**Options:** keep as-is (common among OSS agents), add a disclaimer (done in the
README install section), or gate/strip the flows for a squeaky-clean product.

## 4. Trademark

- All "Prime Intellect" / "Prime Agent" / "oh-my-pi" product branding was
  removed by the rebrand sweep; the README credits the lineage (attribution,
  not affiliation).
- Residual "pi" appears only in internal legacy names (`@cxn/pi-*` package
  scopes, `pi-*` crates, `pi_natives.*.node` filenames) — invisible to users.
- "cxn" has no significant name conflicts (Cambridge Audio CXN is a consumer
  hifi streamer; SAP CAP has a "CXN" notation — different markets).

## 5. Supply-chain / release hygiene

- The upstream-sync workflow merges oh-my-pi into `main` weekly (lane A,
  auto-merge when green). On a public repo this is the main supply-chain
  surface: a compromised upstream `main` could flow into cxn. Mitigations:
  the branding guard fails the run on un-rebranded additions, and the merge
  result is reviewed before merge when conflicts/branding violations occur.
  Consider requiring manual review of sync PRs if the risk profile changes.
- Fork PRs run CI with a read-only token; the native-addon fetch falls back to
  the upstream addon on public npm so fork PRs stay green without access to the
  repo's GitHub Packages.

## 6. GitHub / npm ToS

Publishing this repository (GitHub) and packages (GitHub Packages) complies
with the respective ToS. Nothing in the tree requires acceptance of any
non-standard agreement to redistribute.
