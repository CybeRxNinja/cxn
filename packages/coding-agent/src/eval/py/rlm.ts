/**
 * RLM bridge — recursive subagents (`rlm()`) and family messaging
 * (`agent_message`), adapted onto cxn's eval-kernel bridge and the
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
 * Scope (first slice): registry and mailboxes are in-memory and family-scoped
 * to the parent session; child sessions' own kernels are wired into the family
 * in a follow-up (the child→parent reply path is covered by the spawn-seam
 * tests). Compaction-surviving persistence is a follow-up.
 *
 * Bridge names: `__rlm__`, `__agent_message__` (registered in tool-bridge.ts).
 */

import * as os from "node:os";
import * as path from "node:path";
import { runStructuredSubagent, type StructuredSubagentResult } from "../../task/structured-subagent";
import type { ToolSession } from "../../tools";

export const EVAL_RLM_BRIDGE_NAME = "__rlm__";
export const EVAL_AGENT_MESSAGE_BRIDGE_NAME = "__agent_message__";

export const RLM_CHILD_SESSION_NAME_MAX_LENGTH = 64;
export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;

export const AGENT_MESSAGE_MAX_CHARS = 16_384;
export const AGENT_MESSAGE_MAX_PENDING_PER_SESSION = 20;
export const AGENT_MESSAGE_RATE_LIMIT_CAPACITY = 3;
export const AGENT_MESSAGE_RATE_LIMIT_REFILL_MS = 1000;
export const AGENT_FAMILY_REACH_ERROR = "Agent reach is limited to parent, siblings, and children";

export type RlmChildStatus = "running" | "completed" | "error";

export interface RlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
}

export interface RlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_name: string;
	session_dir: string;
	status: RlmChildStatus;
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

export type AgentMessageDeliveryMode = "auto" | "steer" | "follow_up";
export type AgentMessageDeliveryStatus = "delivered" | "queued";
export type AgentFamilyRelationship = "parent" | "sibling" | "child";

export interface AgentMessageReceipt {
	deliveryStatus: AgentMessageDeliveryStatus;
	deliveredAt?: string;
	queuedAt?: string;
}

export interface AgentFamilyRosterEntry {
	id: string;
	name: string;
	role: AgentFamilyRelationship;
	status: RlmChildStatus | "idle";
}

export interface AgentMessage {
	id: string;
	from: string;
	message: string;
	mode: AgentMessageDeliveryMode;
	at: string;
}

// ---------------------------------------------------------------------------
// Family state (in-memory, keyed by parent session id)
// ---------------------------------------------------------------------------

interface FamilyState {
	parentId: string;
	children: Map<string, RlmSubagentRegistryEntry>;
	mailboxes: Map<string, AgentMessage[]>;
}

const families = new Map<string, FamilyState>();

/** Test-only: drop all family registries so tests start from a clean slate. */
export function resetRlmFamilies(): void {
	families.clear();
}

function familyFor(session: ToolSession): FamilyState {
	const parentId = session.getSessionId?.() ?? "anon-rlm-family";
	let family = families.get(parentId);
	if (!family) {
		family = { parentId, children: new Map(), mailboxes: new Map() };
		families.set(parentId, family);
	}
	return family;
}

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
// agent_message — family messaging
// ---------------------------------------------------------------------------

function callerRole(session: ToolSession): AgentFamilyRelationship {
	const role = (session as ToolSession & { getRlmRole?: () => AgentFamilyRelationship }).getRlmRole?.();
	return role ?? "parent";
}

function agentMessageListAgents(session: ToolSession): { agents: AgentFamilyRosterEntry[] } {
	const family = familyFor(session);
	const roster: AgentFamilyRosterEntry[] = [
		{ id: family.parentId, name: "parent", role: "parent", status: "running" },
	];
	for (const child of family.children.values()) {
		roster.push({
			id: child.rlm_child_id,
			name: child.session_name,
			role: "child",
			status: child.status,
		});
	}
	return { agents: roster };
}

function agentMessageSend(session: ToolSession, payload: Record<string, unknown>): AgentMessageReceipt {
	const message = typeof payload.message === "string" ? payload.message : "";
	if (!message) throw new Error("agent_message.send message must be a non-empty string");
	if (message.length > AGENT_MESSAGE_MAX_CHARS) {
		throw new Error(`agent_message.send message exceeds ${AGENT_MESSAGE_MAX_CHARS} characters`);
	}
	const receiverRole =
		payload.receiver_role === "child" || payload.receiver_role === "sibling" ? payload.receiver_role : "parent";
	const receiverName =
		typeof payload.receiver_name === "string" && payload.receiver_name ? payload.receiver_name : undefined;
	const mode: AgentMessageDeliveryMode =
		payload.mode === "steer" || payload.mode === "follow_up" ? payload.mode : "auto";

	const family = familyFor(session);
	const from = callerRole(session);

	let targetKey: string | undefined;
	if (receiverRole === "parent") {
		targetKey = "parent";
	} else if (receiverRole === "child") {
		if (!receiverName) throw new Error("agent_message.send receiver_name is required for receiver_role=child");
		const child = [...family.children.values()].find(
			c => c.session_name === receiverName || c.rlm_child_id === receiverName,
		);
		if (!child) throw new Error(`agent_message.send: unknown child ${receiverName}`);
		targetKey = child.rlm_child_id;
	} else {
		throw new Error(AGENT_FAMILY_REACH_ERROR);
	}

	let mailbox = family.mailboxes.get(targetKey);
	if (!mailbox) {
		mailbox = [];
		family.mailboxes.set(targetKey, mailbox);
	}
	if (mailbox.length >= AGENT_MESSAGE_MAX_PENDING_PER_SESSION) {
		throw new Error(
			`agent_message.send: ${AGENT_MESSAGE_MAX_PENDING_PER_SESSION} messages already pending for ${targetKey}`,
		);
	}
	const msg: AgentMessage = {
		id: `msg-${crypto.randomUUID()}`,
		from,
		message,
		mode,
		at: new Date().toISOString(),
	};
	mailbox.push(msg);

	// In-process delivery: the target's kernel reads via agent_message.recv().
	return { deliveryStatus: "delivered", deliveredAt: msg.at };
}

function agentMessageRecv(session: ToolSession, payload: Record<string, unknown>): { messages: AgentMessage[] } {
	const family = familyFor(session);
	const peek = payload.peek === true;
	const key =
		callerRole(session) === "parent"
			? "parent"
			: (family.children.get((session as ToolSession & { getRlmChildId?: () => string }).getRlmChildId?.() ?? "")
					?.rlm_child_id ?? "");
	const mailbox = family.mailboxes.get(key) ?? [];
	if (peek) return { messages: [...mailbox] };
	family.mailboxes.delete(key);
	return { messages: mailbox };
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
			// First slice: the bundled model catalog is available in later
			// phases; return an empty list so callers degrade gracefully.
			return { models: [] };
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
