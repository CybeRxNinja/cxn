#!/usr/bin/env bun
/**
 * Branding guard for cxn.
 *
 * Enforces that no upstream branding leaks into product code:
 *   - omp / oh-my-pi / Oh My Pi        (can1357/oh-my-pi)
 *   - prime-agent / Prime Agent        (PrimeIntellect-ai/prime-agent)
 *   - primeintellect / Prime Intellect / app.primeintellect.ai
 *   - @mariozechner / @earendil-works  (legacy pi scopes)
 *
 * Context-aware allowlists:
 *   - `can1357/oh-my-pi` upstream URLs are allowed (repository/homepage
 *     fields, docs, installer references) — branding is anything else.
 *   - Legacy scopes (@mariozechner, @earendil-works) are allowed in docs/
 *     and the legacy extension-compat shims, where they are historical
 *     references, not branding.
 *   - Attribution docs (README, PLAN.md, UPSTREAM.md, CHANGELOG, LICENSE)
 *     are skipped by design.
 *
 * Usage: bun scripts/check-branding.ts
 * Exit 1 with a report when violations are found.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SELF = "scripts/check-branding.ts";

// docs/ legitimately reference the upstreams we port from (porting guides,
// spike reports); the strict brand rules target product code.
const REFERENCE_ALLOWED = (rel: string): boolean => rel.startsWith("docs/") || rel === SELF;

// CI tooling legitimately references the upstream npm leaf as the fork-PR
// native-addon fallback; like the upstream-sync skip below, this is
// operational plumbing, not branding.
const CI_REFERENCE_ALLOWED = (rel: string): boolean => REFERENCE_ALLOWED(rel) || rel.startsWith(".github/workflows/");

// Test fixtures legitimately assert upstream-compat behavior (parsing
// can1357/oh-my-pi URLs, upstream wire strings) — same rationale as the
// `/test/` exemption already granted to the legacy scopes below. Tests are
// dev-time assertions, not product code.
const TEST_FIXTURE_ALLOWED = (rel: string): boolean =>
	CI_REFERENCE_ALLOWED(rel) || rel.includes("/test/") || rel.endsWith(".test.ts") || rel.startsWith("test/");

const LEGACY_ALLOWED = (rel: string): boolean =>
	REFERENCE_ALLOWED(rel) ||
	rel.includes("/extensibility/") ||
	rel.includes("legacy") ||
	rel.includes("scope-alias") ||
	rel.includes("/test/") ||
	rel.includes("metaharness/") ||
	rel.endsWith("model-registry.ts") ||
	rel.endsWith("session-tools.ts") ||
	rel === "packages/tui/src/keys.ts";

interface Rule {
	pattern: RegExp;
	label: string;
	allowed: (rel: string) => boolean;
}

const RULES: Rule[] = [
	{ pattern: /\bomp\b/, label: "omp", allowed: REFERENCE_ALLOWED },
	// `can1357/oh-my-pi` URLs are upstream references, not branding; CI
	// workflows may reference the upstream npm leaf for the fork-PR fallback;
	// test fixtures may assert upstream URL parsing / wire behavior.
	{ pattern: /(?<!can1357\/)oh-my-pi/, label: "oh-my-pi", allowed: TEST_FIXTURE_ALLOWED },
	{ pattern: /Oh My Pi/, label: "Oh My Pi", allowed: REFERENCE_ALLOWED },
	{ pattern: /prime-agent/, label: "prime-agent", allowed: REFERENCE_ALLOWED },
	{ pattern: /Prime Agent/, label: "Prime Agent", allowed: REFERENCE_ALLOWED },
	{ pattern: /primeintellect/i, label: "primeintellect", allowed: REFERENCE_ALLOWED },
	{ pattern: /Prime Intellect/, label: "Prime Intellect", allowed: REFERENCE_ALLOWED },
	{ pattern: /app\.primeintellect\.ai/, label: "app.primeintellect.ai", allowed: REFERENCE_ALLOWED },
	{ pattern: /@mariozechner/, label: "@mariozechner", allowed: LEGACY_ALLOWED },
	{ pattern: /@earendil-works/, label: "@earendil-works", allowed: LEGACY_ALLOWED },
];

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"bazel-bin",
	"bazel-out",
	"bazel-testlogs",
	"bazel-pi",
	"bazel-oh-my-pi",
	"research",
	"assets",
]);

const SKIP_FILE = (p: string): boolean => {
	const base = p.split("/").pop() ?? "";
	if (base === "LICENSE") return true;
	if (base === "CHANGELOG.md") return true;
	if (base === "README.md") return true;
	if (base === "PLAN.md" || base === "UPSTREAM.md") return true;
	// Upstream-sync tooling must reference upstream repos/URLs.
	if (
		p.startsWith("scripts/upstream-sync") ||
		p.startsWith("scripts/port-rlm") ||
		p.startsWith(".github/workflows/upstream-sync")
	)
		return true;
	// Lockfiles are generated.
	if (base === "flake.lock" || base === "bun.lock" || base === "Cargo.lock" || base === "MODULE.bazel.lock")
		return true;
	return false;
};

const SCAN_EXT = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".sh",
	".ps1",
	".rs",
	".py",
	".nix",
	".toml",
	".yml",
	".yaml",
	".md",
	".txt",
	".css",
]);

interface Violation {
	file: string;
	line: number;
	match: string;
	rule: string;
}

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) walk(full, out);
		else out.push(full);
	}
}

function main(): void {
	const files: string[] = [];
	walk(ROOT, files);

	const violations: Violation[] = [];
	for (const file of files) {
		const rel = relative(ROOT, file).replaceAll("\\", "/");
		if (SKIP_FILE(rel)) continue;
		const ext = rel.slice(rel.lastIndexOf("."));
		if (!SCAN_EXT.has(ext)) continue;

		const content = readFileSync(file, "utf-8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			for (const rule of RULES) {
				if (rule.allowed(rel)) continue;
				const m = lines[i].match(rule.pattern);
				if (m) {
					violations.push({ file: rel, line: i + 1, match: m[0], rule: rule.label });
				}
			}
		}
	}

	if (violations.length > 0) {
		console.error(`Branding guard: ${violations.length} violation(s) found:\n`);
		for (const v of violations.slice(0, 100)) {
			console.error(`  ${v.file}:${v.line}  ${JSON.stringify(v.match)}  (${v.rule})`);
		}
		if (violations.length > 100) console.error(`  ... and ${violations.length - 100} more`);
		process.exit(1);
	}

	console.log(`Branding guard: clean (${files.length} files scanned)`);
}

main();
