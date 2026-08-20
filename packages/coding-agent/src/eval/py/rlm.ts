/**
 * RLM bridge — recursive subagents (`rlm()`) and family messaging
 * (`agent_message`), adapted onto omp's eval-kernel bridge and the
 * structured-subagent executor.
 *
 * Semantics follow the RLM model:
 *   - `rlm(prompt, name=…)` admits a child immediately and returns a spawn
 *     handle `{ rlm_child_id, name, session_dir, model }`; the child runs
 *     detached and its status is tracked in a parent-scoped registry.
 *   - Children are real structured subagents (`runStructuredSubagent` with
 *     `keepAlive` + `retainArtifacts`), so each child is a full agent session
 *     with its own tools, session dir, and — via the eval kernel — the same
 *     prelude helpers.
 *   - `agent_message` routes messages within the family (parent ↔ direct
 *     children) through per-family in-process mailboxes with delivered/queued
 *     receipts and rate limits.
 *
 * Scope: registry and mailboxes are in-memory and family-scoped to the parent
 * session, and a child's own kernel is wired into its parent's family (so a
 * child's `agent_message.recv()` drains its real mailbox) — see family-store.ts.
 * Compaction-surviving persistence is a follow-up.
 *
 * Bridge names: `__rlm__`, `__agent_message__` (registered in tool-bridge.ts).
 */

import * as os from "node:os";
import * as path from "node:path";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@cyberxninja-omp/pi-catalog/models";
import type { Api, Model } from "@cyberxninja-omp/pi-catalog/types";
import { runStructuredSubagent, type StructuredSubagentResult } from "../../task/structured-subagent";
import type { ToolSession } from "../../tools";
import {
	agentMessageListAgents,
	agentMessageRecv,
	agentMessageSend,
	familyFor,
	type RlmChildStatus,
	type RlmSubagentRegistryEntry,
	registerRlmChildFamily,
} from "./family-store";

export const EVAL_RLM_BRIDGE_NAME = "__rlm__";
export const EVAL_AGENT_MESSAGE_BRIDGE_NAME = "__agent_message__";

export const RLM_CHILD_SESSION_NAME_MAX_LENGTH = 64;
export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;

// Family registry, mailbox logic, and reach types now live in family-store.ts
// so the store can later be served behind an in-process/daemon `FamilyStore`
// abstraction without touching the spawn plumbing. Re-exported here for
// backward compatibility with callers/tests that import from `rlm`.
export {
	AGENT_FAMILY_REACH_ERROR,
	AGENT_MESSAGE_MAX_CHARS,
	AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
	resetRlmFamilies,
} from "./family-store";

export interface RlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
}

export interface RlmSpawnRequest {
	prompt: string;
	name?: string;
	model?: string;
}

export interface RlmSpawnOutcome {
	status: RlmChildStatus;
	error?: string;
}

export type RlmSpawnFn = (session: ToolSession, request: RlmSpawnRequest, childId: string) => Promise<RlmSpawnOutcome>;

// ---------------------------------------------------------------------------
// Spawn machinery
// ---------------------------------------------------------------------------

/** Test seam: override the child spawner (defaults to a real structured subagent). */
let spawnOverride: RlmSpawnFn | undefined;
export function setRlmSpawnOverride(fn: RlmSpawnFn | undefined): void {
	spawnOverride = fn;
}

/** Create a readable, collision-resistant default child name usable as a message selector. */
export function createDefaultRlmChildName(prompt: string, childId: string): string {
	const promptSlug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const idSuffix =
		childId
			.replace(/^rlm-/, "")
			.replace(/[^A-Za-z0-9]+/g, "")
			.slice(-8) || "child";
	const fixedLength = "subagent--".length + idSuffix.length;
	const promptPart = (promptSlug || "worker")
		.slice(0, Math.max(1, RLM_CHILD_SESSION_NAME_MAX_LENGTH - fixedLength))
		.replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${idSuffix}`;
}

function childSessionDir(session: ToolSession, childId: string): string {
	const sessionFile = session.getSessionFile?.();
	if (sessionFile) return path.join(sessionFile.slice(0, -6), childId);
	const artifacts = session.getArtifactsDir?.();
	if (artifacts) return path.join(artifacts, childId);
	return path.join(os.tmpdir(), `cxn-rlm-child-${childId}`);
}

/** Default spawner: a real, detached structured subagent. */
async function defaultSpawn(session: ToolSession, request: RlmSpawnRequest, childId: string): Promise<RlmSpawnOutcome> {
	try {
		const result: StructuredSubagentResult = await runStructuredSubagent({
			session,
			invocationKind: "eval",
			assignment: request.prompt,
			identity: { label: request.name, id: childId },
			...(request.model !== undefined ? { model: request.model } : {}),
			keepAlive: true,
			retainArtifacts: true,
			shareEvalSession: false,
		});
		const ok = result.result.exitCode === 0 && !result.result.error && !result.result.aborted;
		return {
			status: ok ? "completed" : "error",
			error: ok ? undefined : (result.result.error ?? `exit ${result.result.exitCode}`),
		};
	} catch (error) {
		return { status: "error", error: error instanceof Error ? error.message : String(error) };
	}
}

function resolveChildName(value: unknown, childId: string, prompt: string): string {
	if (value === undefined) return createDefaultRlmChildName(prompt, childId);
	if (typeof value !== "string" || !value.trim()) throw new Error("rlm name must be a non-empty string");
	const name = value.trim();
	if (name.length > RLM_CHILD_SESSION_NAME_MAX_LENGTH) {
		throw new Error(`rlm name must be at most ${RLM_CHILD_SESSION_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

function resolveChildModel(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error("rlm model must be a non-empty string");
	return value.trim();
}

async function rlmRun(session: ToolSession, payload: Record<string, unknown>): Promise<RlmSpawnHandle> {
	if (typeof payload.prompt !== "string" || !payload.prompt.trim()) {
		throw new Error("rlm.run prompt must be a non-empty string");
	}
	const prompt = payload.prompt;
	const rawKwargs =
		payload.kwargs !== undefined && typeof payload.kwargs === "object" && payload.kwargs !== null
			? (payload.kwargs as Record<string, unknown>)
			: {};
	const kwargs: Record<string, unknown> = rawKwargs;
	const childId = `rlm-${crypto.randomUUID()}`;
	const name = resolveChildName(kwargs.name, childId, prompt);
	const model = resolveChildModel(kwargs.model) ?? session.getActiveModelString?.() ?? "default";

	const family = familyFor(session);
	const entry: RlmSubagentRegistryEntry = {
		rlm_child_id: childId,
		active_session_id: null,
		session_id: null,
		session_name: name,
		session_dir: childSessionDir(session, childId),
		status: "running",
	};
	family.children.set(childId, entry);
	registerRlmChildFamily(childId, family.parentId);

	const spawn = spawnOverride ?? defaultSpawn;
	void spawn(session, { prompt, name, model }, childId)
		.then(outcome => {
			const current = family.children.get(childId);
			if (current) current.status = outcome.status;
		})
		.catch(() => {
			const current = family.children.get(childId);
			if (current) current.status = "error";
		});

	return { rlm_child_id: childId, name, session_dir: entry.session_dir, model };
}

function rlmListSubagents(session: ToolSession): { subagents: RlmSubagentRegistryEntry[] } {
	const family = familyFor(session);
	return { subagents: [...family.children.values()] };
}

async function rlmDeleteSubagent(
	session: ToolSession,
	payload: Record<string, unknown>,
): Promise<{ subagent: RlmSubagentRegistryEntry; outcome: "deleted" | "skipped_running" }> {
	const target = typeof payload.target === "string" ? payload.target.trim() : "";
	if (!target) throw new Error("rlm.delete_subagent target must be a non-empty string");
	const family = familyFor(session);
	const entry = family.children.get(target);
	if (!entry) throw new Error(`rlm.delete_subagent: unknown child ${target}`);
	if (entry.status === "running") {
		return { subagent: entry, outcome: "skipped_running" };
	}
	family.children.delete(target);
	return { subagent: entry, outcome: "deleted" };
}

// ---------------------------------------------------------------------------
// find_models: bundled catalog query
// ---------------------------------------------------------------------------

/** Compact model summary surfaced by the `find_models` op. */
export interface RlmCatalogModelSummary {
	id: string;
	name: string;
	provider: string;
	api: string;
	reasoning: boolean;
	contextWindow: number | null;
	inputModes: readonly ("text" | "image")[];
	hasTools: boolean;
}

function catalogModelMatchesCapability(model: Model<Api>, capability: string): boolean {
	switch (capability.toLowerCase()) {
		case "reasoning":
			return model.reasoning;
		case "vision":
		case "image":
			return model.input.includes("image");
		case "tools":
		case "tool_use":
			return model.supportsTools !== false;
		case "text":
			return model.input.includes("text");
		default:
			return false;
	}
}

/**
 * Query the bundled model catalog across every provider. Filters are optional:
 * `query` is a case-insensitive substring over id/name/provider/api; `provider`
 * is an exact (case-insensitive) provider match; `capability` narrows by
 * reasoning / vision / tools / text support. Results are sorted by provider
 * then id and capped at MAX_RLM_MODEL_SEARCH_LIMIT.
 */
export function findCatalogModels(payload: Record<string, unknown>): RlmCatalogModelSummary[] {
	const query =
		typeof payload.query === "string" && payload.query.trim() ? payload.query.trim().toLowerCase() : undefined;
	const provider =
		typeof payload.provider === "string" && payload.provider.trim()
			? payload.provider.trim().toLowerCase()
			: undefined;
	const capability =
		typeof payload.capability === "string" && payload.capability.trim()
			? payload.capability.trim().toLowerCase()
			: undefined;

	const results: RlmCatalogModelSummary[] = [];
	for (const prov of getBundledProviders()) {
		if (provider && prov.toLowerCase() !== provider) continue;
		for (const model of getBundledModels(prov as GeneratedProvider)) {
			if (query) {
				const haystack = `${model.id} ${model.name} ${model.provider} ${String(model.api)}`.toLowerCase();
				if (!haystack.includes(query)) continue;
			}
			if (capability && !catalogModelMatchesCapability(model, capability)) continue;
			results.push({
				id: model.id,
				name: model.name,
				provider: model.provider,
				api: String(model.api),
				reasoning: model.reasoning,
				contextWindow: model.contextWindow,
				inputModes: model.input,
				hasTools: model.supportsTools !== false,
			});
		}
	}

	results.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	return results.slice(0, MAX_RLM_MODEL_SEARCH_LIMIT);
}

// ---------------------------------------------------------------------------
// Bridge dispatch
// ---------------------------------------------------------------------------

export async function runRlmBridge(session: ToolSession, payload: unknown): Promise<unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("__rlm__ payload must be an object");
	}
	const p = payload as Record<string, unknown>;
	switch (p.op) {
		case "run":
			return await rlmRun(session, p);
		case "list_subagents":
			return rlmListSubagents(session);
		case "delete_subagent":
			return await rlmDeleteSubagent(session, p);
		case "find_models":
			return { models: findCatalogModels(p) };
		default:
			throw new Error(`__rlm__ unknown op: ${String(p.op)}`);
	}
}

export async function runAgentMessageBridge(session: ToolSession, payload: unknown): Promise<unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("__agent_message__ payload must be an object");
	}
	const p = payload as Record<string, unknown>;
	switch (p.op) {
		case "list_agents":
			return agentMessageListAgents(session);
		case "send":
			return agentMessageSend(session, p);
		case "recv":
			return agentMessageRecv(session, p);
		default:
			throw new Error(`__agent_message__ unknown op: ${String(p.op)}`);
	}
}
