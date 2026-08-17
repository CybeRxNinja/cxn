#!/usr/bin/env bun
/**
 * Phase 1 — RLM kernel spike.
 *
 * Goal: prove an RLM-style turn works through cxn's existing `eval` Python
 * kernel, without porting any upstream RLM machinery:
 *
 *   1. Persistent kernel — Python state survives across cells.
 *   2. Host request — prelude helpers (`read`, `write`) call host tools.
 *   3. Tool call — the `tool.*` proxy invokes ANY host tool over the bridge.
 *   4. Shell — `%%bash` cells run commands in the same session.
 *
 * The spike drives the real `executePython` path (kernel subprocess + NDJSON
 * runner + HTTP loopback tool bridge) with a minimal ToolSession whose fake
 * tools use the real filesystem and shell. Outputs a report; exits non-zero
 * on failure.
 *
 * Usage: bun scripts/rlm-spike.ts
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeAllKernelSessions, executePython } from "../packages/coding-agent/src/eval/py/executor";
import { disposePyToolBridge } from "../packages/coding-agent/src/eval/py/tool-bridge";
import type { ToolSession } from "../packages/coding-agent/src/tools";
import type { AgentTool } from "../packages/coding-agent/src/tools/types";

// ---------------------------------------------------------------------------
// Minimal ToolSession with real-fs / real-shell fake tools.
// ---------------------------------------------------------------------------

function makeFakeTool(name: string, cwd: string): AgentTool {
	return {
		name,
		description: `spike fake for ${name}`,
		parameters: {},
		async execute(_callId: string, args: Record<string, unknown>) {
			if (name === "read") {
				const path = String(args.path ?? "");
				const full = join(cwd, path);
				const text = readFileSync(full, "utf-8");
				return { content: [{ type: "text", text }] };
			}
			if (name === "write") {
				const path = String(args.path ?? "");
				const full = join(cwd, path);
				writeFileSync(full, String(args.content ?? ""));
				return { content: [{ type: "text", text: `wrote ${path}` }] };
			}
			if (name === "bash") {
				const command = String(args.command ?? "");
				const proc = Bun.spawn(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
				const [stdout, stderr] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				const text = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
				return { content: [{ type: "text", text }] };
			}
			throw new Error(`spike: unknown tool ${name}`);
		},
	} as AgentTool;
}

function makeToolSession(cwd: string): ToolSession {
	const tools = new Map<string, AgentTool>([
		["read", makeFakeTool("read", cwd)],
		["write", makeFakeTool("write", cwd)],
		["bash", makeFakeTool("bash", cwd)],
	]);
	return {
		cwd,
		hasUI: false,
		getToolByName: (name: string) => tools.get(name),
	} as ToolSession;
}

// ---------------------------------------------------------------------------
// Spike runner.
// ---------------------------------------------------------------------------

const results: Array<{ label: string; ok: boolean; detail: string }> = [];

async function runCell(cwd: string, session: ToolSession, label: string, code: string): Promise<string> {
	const result = await executePython(code, {
		cwd,
		sessionId: "rlm-spike",
		toolSession: session,
		kernelMode: "session",
		timeoutMs: 30_000,
	});
	const output = result.output.trim();
	const ok = result.exitCode === 0 && !result.cancelled;
	results.push({ label, ok, detail: output.slice(0, 300) });
	if (!ok) {
		console.error(`\n[FAIL] ${label}\n${output}`);
	} else {
		console.log(
			`[ok] ${label}:\n${output
				.split("\n")
				.map(line => `     ${line}`)
				.join("\n")}`,
		);
	}
	return output;
}

async function main(): Promise<void> {
	const workdir = mkdtempSync(join(tmpdir(), "cxn-rlm-spike-"));
	const samplePath = join(workdir, "sample.txt");
	writeFileSync(samplePath, "hello from the RLM spike\nline two\n");
	const session = makeToolSession(workdir);

	console.log(`Spike workdir: ${workdir}\n`);

	// 1. State setup (persistence proof).
	await runCell(
		workdir,
		session,
		"1. python state setup",
		`task_ctx = {"files": ["a.py", "b.py"]}
total = sum(len(f) for f in task_ctx["files"])
print("total:", total)`,
	);

	// 2. Host request: prelude read() -> bridge -> host read tool (real fs).
	const readOut = await runCell(
		workdir,
		session,
		"2. prelude read() via host bridge",
		`contents = read("sample.txt")
print("first line:", contents.splitlines()[0])`,
	);

	// 3. Tool call: tool.bash proxy -> bridge -> host bash tool (real shell).
	const bashOut = await runCell(
		workdir,
		session,
		"3. tool.bash proxy via host bridge",
		`out = tool.bash(command="echo bridge-works-$((40+2))")
print("bash result:", out.strip())`,
	);

	// 4. Persistence: state from cell 1 must still be alive.
	const persistOut = await runCell(
		workdir,
		session,
		"4. state persisted across cells",
		`print("persisted:", task_ctx["files"] == ["a.py", "b.py"] and total == 8)`,
	);

	// 5. Round trip through the bridge: write() then read().
	const roundtripOut = await runCell(
		workdir,
		session,
		"5. write()/read() round trip",
		`write("out.txt", "written by the RLM spike")
print("read back:", read("out.txt"))`,
	);

	// 6. Shell magic: %%bash in the same persistent session.
	const magicOut = await runCell(
		workdir,
		session,
		"6. %%bash magic",
		`%%bash
echo magic-works-$((1+1))`,
	);

	// -----------------------------------------------------------------------
	console.log("\n=== SPIKE REPORT ===\n");
	let failures = 0;
	for (const r of results) {
		console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label}`);
		if (!r.ok) failures += 1;
	}

	const readBridged = readOut.includes("hello from the RLM spike");
	const bashBridged = bashOut.includes("bridge-works-42");
	const roundtripBridged = roundtripOut.includes("written by the RLM spike");
	const magicWorked = magicOut.includes("magic-works-2");
	const persistenceWorked = persistOut.includes("persisted: True");

	console.log(`
Kernel persistence:        ${persistenceWorked ? "PASS" : "FAIL"}
Prelude read() -> bridge:  ${readBridged ? "PASS" : "FAIL"}
tool.bash() -> bridge:     ${bashBridged ? "PASS" : "FAIL"}
write()/read() round trip: ${roundtripBridged ? "PASS" : "FAIL"}
%%bash magic:              ${magicWorked ? "PASS" : "FAIL"}
`);
	if (failures > 0 || !readBridged || !bashBridged || !roundtripBridged || !magicWorked || !persistenceWorked) {
		console.error("RLM kernel spike FAILED — see details above.");
		process.exitCode = 1;
	} else {
		console.log("RLM kernel spike PASSED: an RLM-style turn runs on the existing eval kernel.");
	}
}

main()
	.finally(async () => {
		await disposeAllKernelSessions();
		await disposePyToolBridge();
	})
	.then(() => process.exit(process.exitCode ?? 0))
	.catch(err => {
		console.error(err);
		process.exit(1);
	});
