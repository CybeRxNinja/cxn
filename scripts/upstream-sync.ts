#!/usr/bin/env bun
/**
 * Upstream sync for cxn.
 *
 * Lane A (omp): merge can1357/oh-my-pi/main into a sync branch on top of our
 * main, update UPSTREAM.md, run the branding guard, push, open a PR, and
 * auto-merge it when everything is clean (CI-gated via gh pr merge --auto).
 * Conflicting hunks resolve with `-X ours` (keep our rebranded lines); the
 * branding guard is the backstop — if upstream reintroduced branding, the PR
 * is labeled and left for manual review.
 *
 * Lane B (prime-agent): scaffold only. The RLM port (Phase 1-2 of PLAN.md)
 * will drive this lane with `git format-patch` ranges applied selectively.
 *
 * Usage:
 *   GH_TOKEN=<pat> bun scripts/upstream-sync.ts [omp|prime-agent]
 *
 * Env:
 *   GH_TOKEN      GitHub token (repo + pull-requests scopes)
 *   AUTO_MERGE    "1" to enable gh pr merge --auto on clean syncs
 *   SYNC_SINCE    override the shallow-since window (default 90 days)
 */

import { $ } from "bun";

const LANE = process.argv[2] ?? "omp";
const UPSTREAM = "upstream-omp";
const UPSTREAM_URL = "https://github.com/can1357/oh-my-pi.git";
const PA_UPSTREAM = "upstream-pa";
const PA_URL = "https://github.com/PrimeIntellect-ai/prime-agent.git";
const AUTO_MERGE = process.env.AUTO_MERGE === "1";

// ---------------------------------------------------------------------------
// Lane B (scaffold)
// ---------------------------------------------------------------------------
if (LANE === "prime-agent") {
	try {
		await $`git remote add ${PA_UPSTREAM} ${PA_URL}`.quiet();
	} catch {
		// already present
	}
	console.log(
		"Lane B (prime-agent) is scaffolded only: the RLM module port lands in Phase 1-2 of PLAN.md, " +
			"after which this lane fetches upstream-pa and applies the tracked RLM paths via format-patch.",
	);
	process.exit(0);
}
if (LANE !== "omp") {
	console.error(`Unknown lane: ${LANE} (expected omp | prime-agent)`);
	process.exit(1);
}

const fail = (msg: string): never => {
	console.error(`upstream-sync: ${msg}`);
	process.exit(1);
};

// ---------------------------------------------------------------------------
// Lane A: oh-my-pi
// ---------------------------------------------------------------------------
try {
	await $`git remote add ${UPSTREAM} ${UPSTREAM_URL}`.quiet();
} catch {
	// already present
}

// GitHub-hosted runners have no git identity; git refuses to create the merge
// commit (and the sync-point commit below) without one. Set a local identity
// scoped to this repo so the sync can commit on any machine.
await $`git config user.name "cxn-sync[bot]"`.quiet();
await $`git config user.email "cxn-sync[bot]@users.noreply.github.com"`.quiet();

// Full fetch (no shallow): the pushed merge result must carry complete
// ancestry or GitHub rejects the push (index-pack "did not receive expected
// object"). The full upstream repo is only ~500 MB; CI runners handle it fast.
console.log(`Fetching ${UPSTREAM} (full)...`);
await $`git fetch ${UPSTREAM} main`;

const upstreamSha = (await $`git rev-parse ${UPSTREAM}/main`.text()).trim();
const shortSha = upstreamSha.slice(0, 7);
const date = new Date().toISOString().slice(0, 10);
const branch = `sync/${UPSTREAM}-${date}`;

console.log(`Upstream: ${shortSha} (${upstreamSha})`);
console.log(`Sync branch: ${branch}`);

// Reset the sync branch onto our main (force if it exists from a previous run).
await $`git switch -C ${branch} main`;

// Try a plain merge first; on conflict retry with -X ours (keep our lines).
let mergeResult = await $`git merge ${UPSTREAM}/main -m "chore: sync upstream omp @ ${shortSha}"`.nothrow();
let usedOurs = false;
if (mergeResult.exitCode !== 0) {
	console.log("Merge conflicts; retrying with -X ours (keep cxn lines)...");
	await $`git merge --abort`.nothrow();
	mergeResult =
		await $`git merge -X ours ${UPSTREAM}/main -m "chore: sync upstream omp @ ${shortSha} (conflicts resolved with -X ours)"`.nothrow();
	usedOurs = true;
}
if (mergeResult.exitCode !== 0) {
	const conflicts = (await $`git diff --name-only --diff-filter=U HEAD ${UPSTREAM}/main`.nothrow().text()).trim();
	await $`git merge --abort`.nothrow();
	fail(
		`merge against ${UPSTREAM}/main failed even with -X ours. Conflicting paths:\n${conflicts || "(none listed)"}\nResolve manually, then rerun.`,
	);
}

// ---------------------------------------------------------------------------
// Post-merge rebrand pass
// ---------------------------------------------------------------------------
// A plain merge of upstream into a fully-rebranded fork always reintroduces
// upstream identity in the hunks that merged without conflict (files we never
// touched). Mechanically convert those back to cxn so the merged tree builds
// and passes the branding guard:
//   - `@oh-my-pi/` package scopes  -> `@cxn/` (workspace imports must resolve)
//   - bare `oh-my-pi` / `omp`      -> `cxn` (product identity strings)
// `can1357/oh-my-pi` upstream URLs are preserved (references, not branding).
// The branding guard below remains the backstop: anything this pass misses is
// flagged and the PR is labeled for manual review instead of auto-merging.
const REBRAND_SKIP = (rel: string): boolean => {
	const base = rel.split("/").pop() ?? "";
	// Mirror scripts/check-branding.ts: attribution docs, lockfiles, and the
	// sync tooling itself are exempt by design; docs/ may reference upstreams.
	if (rel.startsWith("docs/")) return true;
	if (rel.startsWith(".github/workflows/")) return true;
	if (base === "LICENSE") return true;
	if (base === "CHANGELOG.md") return true;
	if (base === "README.md") return true;
	if (base === "PLAN.md" || base === "UPSTREAM.md") return true;
	if (base === "bun.lock" || base === "flake.lock" || base === "Cargo.lock" || base === "MODULE.bazel.lock")
		return true;
	if (rel.startsWith("scripts/upstream-sync") || rel.startsWith("scripts/port-rlm")) return true;
	return false;
};

async function rebrandSyncedTree(): Promise<void> {
	const changed = (await $`git diff --name-only main...HEAD`.text()).trim().split("\n").filter(Boolean);
	let touched = 0;
	for (const rel of changed) {
		if (REBRAND_SKIP(rel)) continue;
		let text: string;
		try {
			text = await Bun.file(rel).text();
		} catch {
			continue; // binary or unreadable; nothing to rebrand
		}
		const next = text
			.replaceAll("@oh-my-pi/", "@cxn/")
			.replace(/(?<!can1357\/)oh-my-pi/g, "cxn")
			.replace(/\bomp\b/g, "cxn")
			.replace(/Oh My Pi/g, "cxn");
		if (next !== text) {
			await Bun.write(rel, next);
			touched++;
		}
	}
	// Upstream edits occasionally leave auto-fixable lint behind (e.g. an
	// unused import after a refactor); the merged tree must pass the same
	// `biome check` gate CI runs, so apply safe fixes to every changed file
	// plus the targeted unused-import fix (biome marks it unsafe), then
	// verify the changed files are clean before committing.
	if (changed.length > 0) {
		await $`bunx biome check --write ${changed}`.nothrow();
		await $`bunx biome lint --write --unsafe --only=lint/correctness/noUnusedImports ${changed}`.nothrow();
		// The unsafe import removal can leave formatting drift behind (e.g. a
		// leading blank line); run the safe write pass again to clean it up.
		await $`bunx biome check --write ${changed}`.nothrow();
		const verify = await $`bunx biome check ${changed}`.nothrow();
		if (verify.exitCode !== 0) {
			console.error(
				"biome check found non-fixable issues in synced files (see output above); the sync PR will fail CI — fix before merging.",
			);
		}
	}
	// Commit whatever the rebrand and the biome safe-fix pass produced.
	const pending = (await $`git status --porcelain`.text()).trim();
	if (pending.length > 0) {
		await $`git add -A`;
		await $`git commit -m "chore: rebrand synced upstream code (scope + product strings)"`;
	}
	console.log(`Rebrand pass: ${touched} file(s) rewritten.`);
}

async function alignWorkspaceVersions(): Promise<void> {
	// Upstream releases bump every package lockstep; `-X ours` keeps our stale
	// package.jsons, so a merged tree can hold mixed versions (the pi-natives
	// sentinel test fails when lib.rs says 17.3.7 but package.json says 17.3.5).
	// Align the whole workspace to the newest version present in the tree.
	const pkgPaths = Array.from(Bun.Glob.glob("packages/*/package.json").scanSync());
	const versions: Array<{ path: string; version: string }> = [];
	for (const p of pkgPaths) {
		try {
			const data = (await Bun.file(p).json()) as { version?: string };
			if (data.version) versions.push({ path: p, version: data.version });
		} catch {
			// unreadable; skip
		}
	}
	if (versions.length === 0) return;
	const compare = (a: string, b: string): number => {
		const [am, ab, ap] = a.split(".").map(Number);
		const [bm, bb, bp] = b.split(".").map(Number);
		return (am - bm) * 1_000_000 + (ab - bb) * 1_000 + (ap - bp);
	};
	const target = versions
		.map(v => v.version)
		.sort(compare)
		.at(-1)!;
	let changed = false;
	for (const { path: p, version } of versions) {
		if (version === target) continue;
		const text = await Bun.file(p).text();
		const next = text.replace(/"version": "[^"]+"/, `"version": "${target}"`);
		if (next !== text) {
			await Bun.write(p, next);
			changed = true;
		}
	}
	// Root catalog pins @cxn/* entries to the workspace version.
	const rootText = await Bun.file("package.json").text();
	const rootNext = rootText.replace(/("@cxn\/[^"]+":\s*)"[^"]+"/g, `$1"${target}"`);
	if (rootNext !== rootText) {
		await Bun.write("package.json", rootNext);
		changed = true;
	}
	// Rust workspace version; crates follow via version.workspace = true.
	const cargoText = await Bun.file("Cargo.toml").text();
	const cargoNext = cargoText.replace(/^version = "[^"]+"/m, `version = "${target}"`);
	if (cargoNext !== cargoText) {
		await Bun.write("Cargo.toml", cargoNext);
		changed = true;
	}
	// pi-natives sentinel + compiled artifacts must agree with the version.
	const sentinel = `__piNativesV${target.replace(/[^A-Za-z0-9]/g, "_")}`;
	for (const p of [
		"crates/pi-natives/src/lib.rs",
		"packages/natives/native/index.js",
		"packages/natives/native/index.d.ts",
		"packages/natives/native/loader-state.js",
	]) {
		try {
			const text = await Bun.file(p).text();
			const next = text.replace(/__piNativesV[A-Za-z0-9_]+/g, sentinel);
			if (next !== text) {
				await Bun.write(p, next);
				changed = true;
			}
		} catch {
			// missing; skip
		}
	}
	if (changed) {
		await $`git add -A`;
		await $`git commit -m "chore: align workspace versions to ${target} (upstream release)"`;
		console.log(`Aligned workspace versions to ${target}.`);
	}
}

await rebrandSyncedTree();
await alignWorkspaceVersions();

// Record the sync point.
const upPath = "UPSTREAM.md";
let upContent = "";
try {
	upContent = await Bun.file(upPath).text();
} catch {
	// file will be created
}
const pointLine = `- **Sync point:** \`${shortSha}\` (${date}) — lane A (oh-my-pi)`;
const laneHeader = "## Lane A — oh-my-pi (base)";
if (upContent.includes(laneHeader)) {
	upContent = upContent.replace(/- \*\*Sync point:\*\*.*/m, pointLine);
} else {
	upContent += `\n${laneHeader}\n\n${pointLine}\n`;
}
await Bun.write(upPath, upContent);
await $`git add UPSTREAM.md`;
await $`git commit -m "chore: record upstream sync point ${shortSha}"`.nothrow();

// Branding guard: the enforcement backstop for merged upstream code.
const guard = await $`bun scripts/check-branding.ts`.nothrow();
const brandingClean = guard.exitCode === 0;
if (!brandingClean) console.error("Branding guard found violations in the sync (see output above).");

// Type check: `-X ours` keeps our import blocks, so upstream features that
// add new references can arrive with dangling names. Run the same check CI
// gates on; failures label the PR for manual repair instead of auto-merging.
const typecheck = await $`bun run check:ts`.nothrow();
const typesClean = typecheck.exitCode === 0;
if (!typesClean) console.error("Type check failed on the synced tree (see output above); fix before merging.");

// Push + PR. The sync branch is ephemeral (reset from main each run), so a
// re-run force-updates the remote branch with lease safety; a concurrent
// modification of the branch rejects the push loudly instead of silently
// pushing a PR whose head never moved.
if (!process.env.GH_TOKEN) fail("GH_TOKEN is required to push and open the PR");
await $`git push --force-with-lease -u origin ${branch}`;

const prTitle = usedOurs
	? `chore: sync upstream omp @ ${shortSha} (conflicts resolved with -X ours)`
	: `chore: sync upstream omp @ ${shortSha}`;
const body = [
	`Automated sync from [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) @ \`${shortSha}\`.`,
	"",
	`- **Lane:** ${LANE}`,
	`- **Sync branch:** \`${branch}\``,
	usedOurs ? "- **Conflict policy:** `-X ours` applied (kept cxn lines in conflicting hunks) — review the diff." : "",
	brandingClean ? "- **Branding guard:** clean" : "- **Branding guard: VIOLATIONS FOUND** — fix before merging.",
	typesClean ? "- **Type check:** clean" : "- **Type check: FAILED** — fix before merging.",
	"",
	"Merge is enabled (auto-merge) only when CI passes, branding is clean, and the type check is clean.",
]
	.filter(Boolean)
	.join("\n");

// `gh pr create --label` fails when a label does not exist; ensure the sync
// labels exist (no-op if they do, graceful no-op if the token cannot create
// labels — the PR is still created, just unlabeled).
await $`gh label create sync --force --color 5319e7 --description "Automated upstream sync"`.quiet().nothrow();
await $`gh label create sync-branding-violations --force --color b60205 --description "Sync introduced un-rebranded upstream code; review before merge"`
	.quiet()
	.nothrow();
await $`gh label create sync-failed --force --color b60205 --description "Sync failed a gate (type check, branding, lint); fix before merge"`
	.quiet()
	.nothrow();

const existing = (await $`gh pr list --head ${branch} --state open --json number`.quiet().nothrow().text()).trim();
const labels =
	brandingClean && typesClean
		? ["sync"]
		: ["sync", ...(brandingClean ? [] : ["sync-branding-violations"]), ...(typesClean ? [] : ["sync-failed"])];
// `gh pr edit` queries the author via GraphQL, which classic PATs without
// `read:org` cannot run; update through the REST API instead so syncs work
// with limited tokens (GITHUB_TOKEN, fine-grained PATs, classic PATs).
const repoSlug = (await $`git config --get remote.origin.url`.text())
	.trim()
	.replace(/\.git$/, "")
	.replace(/^.*github\.com[/:]/, "");

if (existing && existing !== "[]") {
	const num = (JSON.parse(existing) as Array<{ number: number }>)[0].number;
	await $`gh api -X PATCH repos/${repoSlug}/pulls/${num} -f title=${prTitle} -f body=${body}`.nothrow();
	await $`gh api -X POST repos/${repoSlug}/issues/${num}/labels -f "labels[]=${labels.join(",")}"`.nothrow();
	if (brandingClean && typesClean && AUTO_MERGE) await $`gh pr merge ${num} --auto --squash`.nothrow();
	console.log(`Updated PR #${num}`);
} else {
	const create =
		await $`gh pr create --title ${prTitle} --body ${body} --label ${labels.join(",")} --base main --head ${branch}`.nothrow();
	if (create.exitCode !== 0) fail(`could not create PR: ${create.stderr.toString()}`);
	if (brandingClean && typesClean && AUTO_MERGE) {
		const numMatch = create.stdout.toString().match(/#(\d+)/);
		if (numMatch) await $`gh pr merge ${numMatch[1]} --auto --squash`.nothrow();
	}
	console.log(`Opened PR for sync @ ${shortSha}`);
}

console.log(
	`Sync complete (${shortSha}, usedOurs=${usedOurs}, brandingClean=${brandingClean}, typesClean=${typesClean}).`,
);
