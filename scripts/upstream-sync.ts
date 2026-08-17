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

const since = process.env.SYNC_SINCE;
const sinceArg = since ? new Date(since).toISOString() : new Date(Date.now() - 90 * 86_400_000).toISOString();
console.log(`Fetching ${UPSTREAM} (shallow-since ${sinceArg})...`);
await $`git fetch --shallow-since=${sinceArg} ${UPSTREAM} main`;

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

// Push + PR.
if (!process.env.GH_TOKEN) fail("GH_TOKEN is required to push and open the PR");
await $`git push -u origin ${branch}`.nothrow();

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
	"",
	"Merge is enabled (auto-merge) only when CI passes and branding is clean.",
]
	.filter(Boolean)
	.join("\n");

const existing = (await $`gh pr list --head ${branch} --state open --json number`.quiet().nothrow().text()).trim();
const labels = brandingClean ? ["sync"] : ["sync", "sync-branding-violations"];

if (existing && existing !== "[]") {
	const num = (JSON.parse(existing) as Array<{ number: number }>)[0].number;
	await $`gh pr edit ${num} --title ${prTitle} --body ${body}`;
	await $`gh pr edit ${num} --add-label ${labels.join(",")}`;
	if (brandingClean && AUTO_MERGE) await $`gh pr merge ${num} --auto --squash`.nothrow();
	console.log(`Updated PR #${num}`);
} else {
	const create =
		await $`gh pr create --title ${prTitle} --body ${body} --label ${labels.join(",")} --base main --head ${branch}`.nothrow();
	if (create.exitCode !== 0) fail(`could not create PR: ${create.stderr.toString()}`);
	if (brandingClean && AUTO_MERGE) {
		const numMatch = create.stdout.toString().match(/#(\d+)/);
		if (numMatch) await $`gh pr merge ${numMatch[1]} --auto --squash`.nothrow();
	}
	console.log(`Opened PR for sync @ ${shortSha}`);
}

console.log(`Sync complete (${shortSha}, usedOurs=${usedOurs}, brandingClean=${brandingClean}).`);
