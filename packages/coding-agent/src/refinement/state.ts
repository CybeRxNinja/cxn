/**
 * File-backed harness state store.
 *
 * The harness keeps two scopes, exactly like the /refine harness it ports:
 *   - global: `<agentDir>/harness/harness_state.json` + `refinements.jsonl`,
 *     shared across every session of the agent.
 *   - local:  `<agentDir>/harness/local/<sessionId>/harness_state.json` +
 *     `refinements.jsonl`, scoped to one session.
 *
 * Snapshot/rollback is structural: every applied refinement records
 * before/after snapshots of each touched entry, so a rollback is a derived
 * proposal that reverses them. The store is written atomically (temp file +
 * rename) so a crashed refine never leaves a half-written state file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "../session/agent-session";
import type {
	HarnessEntry,
	HarnessRefinementEvent,
	HarnessScope,
	HarnessState,
	RefinementKind,
	RefinementResult,
} from "./types";

export const HARNESS_DIR_NAME = "harness";
const REFINEMENT_HISTORY_FILE_NAME = "refinements.jsonl";

export function getGlobalHarnessDir(agentDir: string): string {
	return join(agentDir, HARNESS_DIR_NAME);
}

export function getLocalHarnessDir(agentDir: string, sessionId: string): string {
	return join(agentDir, HARNESS_DIR_NAME, "local", sessionId);
}

export function getHarnessStatePath(harnessDir: string): string {
	return join(harnessDir, "harness_state.json");
}

export function getRefinementHistoryPath(harnessDir: string): string {
	return join(harnessDir, REFINEMENT_HISTORY_FILE_NAME);
}

export function emptyHarnessState(): HarnessState {
	return {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: [],
	};
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function normalizeHarnessScope(value: unknown, fallback: HarnessScope): HarnessScope {
	return value === "global" || value === "local" ? value : fallback;
}

export function loadHarnessState(harnessDir: string, scope: HarnessScope = "local"): HarnessState {
	const statePath = getHarnessStatePath(harnessDir);
	if (!existsSync(statePath)) {
		return emptyHarnessState();
	}
	let parsed: Partial<HarnessState>;
	try {
		const raw = JSON.parse(readFileSync(statePath, "utf8"));
		// loadHarnessState runs on every system-prompt build and before each
		// /refine, so a corrupt or unreadable (or non-object) state file must
		// degrade to empty rather than throw and break the session. The next
		// saveHarnessState rewrites it cleanly.
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return emptyHarnessState();
		}
		parsed = raw as Partial<HarnessState>;
	} catch {
		return emptyHarnessState();
	}
	const state = emptyHarnessState();
	state.schema = typeof parsed.schema === "number" ? parsed.schema : 1;
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const records = parsed.entries?.[kind];
		if (records && typeof records === "object") {
			for (const [id, rawEntry] of Object.entries(records)) {
				const entry = objectRecord(rawEntry);
				if (!entry) continue;
				state.entries[kind][id] = {
					...(entry as unknown as HarnessEntry),
					scope: normalizeHarnessScope(entry.scope, scope),
					reference: objectRecord(entry.reference) ?? {},
					arguments: objectRecord(entry.arguments) ?? {},
					metadata: objectRecord(entry.metadata) ?? {},
				};
			}
		}
	}
	if (Array.isArray(parsed.refinements)) {
		state.refinements = parsed.refinements;
	}
	return state;
}

function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | undefined {
	return entry ? JSON.parse(JSON.stringify(entry)) : undefined;
}

/** Merge global + local state for prompt rendering; local entries win on id collisions. */
export function mergeHarnessStates(globalState: HarnessState, localState?: HarnessState): HarnessState {
	const merged = emptyHarnessState();
	merged.schema = Math.max(globalState.schema, localState?.schema ?? 1);
	for (const kind of Object.keys(merged.entries) as RefinementKind[]) {
		for (const [id, entry] of Object.entries(globalState.entries[kind])) {
			const cloned = cloneEntry(entry)!;
			merged.entries[kind][id] = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "global") };
		}
		for (const [id, entry] of Object.entries(localState?.entries[kind] ?? {})) {
			const cloned = cloneEntry(entry)!;
			const scopedEntry = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "local") };
			const mergedId = merged.entries[kind][id] ? `${scopedEntry.scope}:${id}` : id;
			merged.entries[kind][mergedId] = scopedEntry;
		}
	}
	merged.refinements = [...globalState.refinements, ...(localState?.refinements ?? [])];
	return merged;
}

/** Atomic write: temp file + rename, preserving the existing file's mode. */
export function saveHarnessState(harnessDir: string, state: HarnessState): string {
	const statePath = getHarnessStatePath(harnessDir);
	const tempPath = `${statePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	mkdirSync(harnessDir, { recursive: true });
	try {
		const mode = existsSync(statePath) ? statSync(statePath).mode & 0o777 : 0o600;
		writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode });
		renameSync(tempPath, statePath);
	} finally {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
	}
	return statePath;
}

function isRefinementResult(data: unknown): data is RefinementResult {
	return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
}

/** Append a refinement result to the scope's JSONL history. */
export function appendRefinement(harnessDir: string, result: RefinementResult): string {
	const historyPath = getRefinementHistoryPath(harnessDir);
	mkdirSync(harnessDir, { recursive: true });
	writeFileSync(historyPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", flag: "a" });
	return historyPath;
}

export function loadRefinementHistory(harnessDir: string): RefinementResult[] {
	const historyPath = getRefinementHistoryPath(harnessDir);
	if (!existsSync(historyPath)) {
		return [];
	}
	const results: RefinementResult[] = [];
	for (const line of readFileSync(historyPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (isRefinementResult(parsed)) {
				results.push(parsed);
			}
		} catch {
			// Skip malformed lines so a single bad append cannot break rollback.
		}
	}
	return results;
}

/** Merge scope histories, de-duplicating by id; local entries win on conflict. */
export function mergeRefinementHistory(
	global: readonly RefinementResult[],
	local: readonly RefinementResult[],
): RefinementResult[] {
	const byId = new Map<string, RefinementResult>();
	for (const result of global) {
		byId.set(result.id, result);
	}
	for (const result of local) {
		byId.set(result.id, result);
	}
	return [...byId.values()];
}

function compactText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

const DEFAULT_OVERVIEW_ENTRY_LIMIT = 6;
const DEFAULT_OVERVIEW_REFINEMENT_LIMIT = 5;
const DEFAULT_OVERVIEW_CONTENT_LIMIT = 180;

/**
 * Render the merged harness state for the system prompt: a compact overview
 * the model can route against, with the call contract for the native surfaces
 * that execute harness entries.
 */
export function formatHarnessStateForPrompt(
	state: HarnessState,
	options: {
		maxEntriesPerKind?: number;
		maxRefinements?: number;
		maxContentLength?: number;
	} = {},
): string {
	const maxEntriesPerKind = options.maxEntriesPerKind ?? DEFAULT_OVERVIEW_ENTRY_LIMIT;
	const maxRefinements = options.maxRefinements ?? DEFAULT_OVERVIEW_REFINEMENT_LIMIT;
	const maxContentLength = options.maxContentLength ?? DEFAULT_OVERVIEW_CONTENT_LIMIT;
	const lines = [
		"# Continual Harness State",
		"",
		"Local entries belong to this session. Global entries persist across sessions.",
		"The entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying entry only when detail matters.",
		"Default to local refinement for current task progress, temporary blockers, and session coordination. Use global refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.",
		"",
		"When to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, or a harness entry is wrong and should be updated, deleted, or rolled back. Keep harness edits small and evidence-backed.",
		"",
		"Call contract: harness skill entries carry a python `reference` + `arguments` contract for the RLM kernel; invoke the documented module function. Spawn a harness subagent spec by composing a concise task prompt and calling `await rlm('sub-task')`; admission returns a child handle, never the answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)` or `run_subagent(...)`.",
		"",
	];

	let totalEntries = 0;
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entries = Object.values(state.entries[kind]).sort((a, b) =>
			[a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0")),
		);
		totalEntries += entries.length;
		if (kind === "subagent" && entries.length > 0) {
			lines.push(
				`${kind}: ${entries.length} (invoke a spec by turning it into a concise task prompt and spawning with \`await rlm('<task>')\`; admission returns a child handle, never the answer)`,
			);
		} else {
			lines.push(`${kind}: ${entries.length}`);
		}
		for (const entry of entries.slice(0, maxEntriesPerKind)) {
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${compactText(JSON.stringify(entry.arguments), maxContentLength)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${compactText(JSON.stringify(entry.reference), maxContentLength)}`
					: "";
			lines.push(
				`- [${entry.scope ?? "local"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceText}${argumentsText}: ${compactText(
					entry.content,
					maxContentLength,
				)}`,
			);
		}
		const overflow = entries.length - Math.min(entries.length, maxEntriesPerKind);
		if (overflow > 0) {
			lines.push(`- +${overflow} more ${kind} entries`);
		}
		lines.push("");
	}

	if (totalEntries === 0) {
		lines.push("No saved harness entries yet.", "");
	}

	lines.push(`recent refinements: ${state.refinements.length}`);
	for (const event of state.refinements.slice(-maxRefinements)) {
		const changes = event.changes.length > 0 ? event.changes.join(", ") : "no applied edits";
		const outcome = event.outcome ? `; outcome: ${compactText(event.outcome, maxContentLength)}` : "";
		lines.push(`- [${event.id}] ${compactText(event.trigger, maxContentLength)}: ${changes}${outcome}`);
	}
	const refinementOverflow = state.refinements.length - Math.min(state.refinements.length, maxRefinements);
	if (refinementOverflow > 0) {
		lines.push(`- +${refinementOverflow} older refinement events`);
	}

	return lines.join("\n").trim();
}

/** Fuller overview used as the model input to /refine itself (not the prompt). */
export function overviewForPrompt(state: HarnessState): string {
	const lines: string[] = [];
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entries = Object.values(state.entries[kind]);
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, 40)) {
			const content = entry.content.replace(/\s+/g, " ").slice(0, 240);
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${JSON.stringify(entry.arguments).slice(0, 240)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${JSON.stringify(entry.reference).slice(0, 240)}`
					: "";
			lines.push(
				`- [${entry.scope ?? "local"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceText}${argumentsText}: ${content}`,
			);
		}
		if (entries.length > 40) {
			lines.push(`- +${entries.length - 40} more ${kind} entries`);
		}
	}
	return lines.join("\n");
}

export function historyForPrompt(history: readonly RefinementResult[]): string {
	if (history.length === 0) {
		return "No prior refinement history.";
	}
	return history
		.slice(-20)
		.map(item => {
			const edits = item.appliedEdits
				.map(edit => `${edit.applied ? "applied" : "failed"} ${edit.action} ${edit.kind}:${edit.id}`)
				.join(", ");
			const rollback = item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : "";
			return `[${item.id}]${rollback} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
		})
		.join("\n\n");
}

/** Summarize a refinement result for terminal output. */
export function formatRefinementResult(result: RefinementResult): string {
	const lines = [
		`Refinement ${result.id}${result.rollbackOf ? ` (rollback of ${result.rollbackOf})` : ""} — ${result.scope ?? "local"} scope`,
		`Summary: ${result.summary}`,
	];
	if (result.rationale) lines.push(`Rationale: ${result.rationale}`);
	if (result.appliedEdits.length > 0) {
		lines.push("Edits:");
		for (const edit of result.appliedEdits) {
			const status = edit.applied ? "applied" : `failed (${edit.error ?? "unknown error"})`;
			lines.push(`  - ${edit.action} ${edit.kind}:${edit.id} — ${status}`);
		}
	} else {
		lines.push("No edits proposed.");
	}
	if (result.expectedOutcome) lines.push(`Expected outcome: ${result.expectedOutcome}`);
	lines.push("", `Roll back with /refine --rollback ${result.id}`);
	return lines.join("\n");
}

/**
 * Compact harness overview injected into the system prompt alongside the
 * memory-backend developer instructions. Returns undefined until the harness
 * has content, so an unused harness adds no prompt noise.
 */
export function buildHarnessDeveloperInstructions(agentDir: string, session?: AgentSession): string | undefined {
	const sessionId = session?.sessionManager.getSessionId();
	const globalState = loadHarnessState(getGlobalHarnessDir(agentDir), "global");
	const localState = sessionId ? loadHarnessState(getLocalHarnessDir(agentDir, sessionId), "local") : undefined;
	const merged = mergeHarnessStates(globalState, localState);
	const hasEntries = Object.values(merged.entries).some(records => Object.keys(records).length > 0);
	if (!hasEntries && merged.refinements.length === 0) {
		return undefined;
	}
	return [
		"## Continual Harness",
		"",
		formatHarnessStateForPrompt(merged, { maxEntriesPerKind: 4, maxRefinements: 3, maxContentLength: 160 }),
		"",
		"Update this supplemental state with /refine; the base system prompt is immutable.",
	].join("\n");
}

export type { HarnessEntry, HarnessRefinementEvent, HarnessState, RefinementResult };
