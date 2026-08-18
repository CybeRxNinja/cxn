/**
 * RLM family registry + in-process mailboxes.
 *
 * Extracted from `rlm.ts` so the family state can later be served behind a
 * `FamilyStore` abstraction (in-process now; daemon-backed later) without
 * disturbing the spawn plumbing. This module is the single source of truth for
 * family reach and message delivery.
 *
 * Children are spawned as nested *in-process* sessions (see
 * `runSubprocess` in `task/executor.ts` — no OS subprocess), so they share
 * this map with the parent. A child is identified by its `getAgentId()`, which
 * the structured-subagent executor sets to the reserved `rlm_child_id`. We map
 * that id to the parent's family key so a child's `agent_message.recv()`
 * resolves to the *parent's* family instead of a fresh empty one.
 */

import type { ToolSession } from "../../tools";

export const AGENT_MESSAGE_MAX_CHARS = 16_384;
export const AGENT_MESSAGE_MAX_PENDING_PER_SESSION = 20;
export const AGENT_MESSAGE_RATE_LIMIT_CAPACITY = 3;
export const AGENT_MESSAGE_RATE_LIMIT_REFILL_MS = 1000;
export const AGENT_FAMILY_REACH_ERROR = "Agent reach is limited to parent, siblings, and children";

export type RlmChildStatus = "running" | "completed" | "error";

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

export interface RlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_name: string;
	session_dir: string;
	status: RlmChildStatus;
}

interface FamilyState {
	parentId: string;
	children: Map<string, RlmSubagentRegistryEntry>;
	mailboxes: Map<string, AgentMessage[]>;
}

const families = new Map<string, FamilyState>();

/**
 * Maps a child's agent id (which the executor sets to its `rlm_child_id`) to
 * the parent family key. Populated at spawn time by `registerRlmChildFamily`.
 * Only used by the in-process session path; the daemon path addresses families
 * by an explicit `familyId` carried on each request.
 */
const childToFamilyKey = new Map<string, string>();

/** Test-only: drop all family registries so tests start from a clean slate. */
export function resetRlmFamilies(): void {
	families.clear();
	childToFamilyKey.clear();
}

/** Record that a spawned child (agent id === `rlm_child_id`) belongs to `parentFamilyKey`. */
export function registerRlmChildFamily(childAgentId: string, parentFamilyKey: string): void {
	childToFamilyKey.set(childAgentId, parentFamilyKey);
}

// ---------------------------------------------------------------------------
// Explicit-family primitives (shared by the in-process path and the daemon)
// ---------------------------------------------------------------------------

/** Get-or-create the family state for an explicit family id. */
export function familyStateFor(familyId: string): FamilyState {
	let family = families.get(familyId);
	if (!family) {
		family = { parentId: familyId, children: new Map(), mailboxes: new Map() };
		families.set(familyId, family);
	}
	return family;
}

/** Register a child in a family's registry (the daemon is the registry authority). */
export function registerChildInFamily(familyId: string, entry: RlmSubagentRegistryEntry): void {
	familyStateFor(familyId).children.set(entry.rlm_child_id, entry);
}

/** List a family's registered subagents. */
export function listSubagentsInFamily(familyId: string): RlmSubagentRegistryEntry[] {
	return [...familyStateFor(familyId).children.values()];
}

/** Delete a settled child; refuse to delete a still-running one. */
export function deleteSubagentInFamily(
	familyId: string,
	target: string,
): { subagent: RlmSubagentRegistryEntry; outcome: "deleted" | "skipped_running" } {
	const family = familyStateFor(familyId);
	const entry = family.children.get(target);
	if (!entry) throw new Error(`rlm.delete_subagent: unknown child ${target}`);
	if (entry.status === "running") return { subagent: entry, outcome: "skipped_running" };
	family.children.delete(target);
	return { subagent: entry, outcome: "deleted" };
}

/** Deliver a message within a family. `from` is the sender's family relationship. */
export function sendToFamily(
	familyId: string,
	from: AgentFamilyRelationship,
	payload: Record<string, unknown>,
): AgentMessageReceipt {
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

	const family = familyStateFor(familyId);

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

	return { deliveryStatus: "delivered", deliveredAt: msg.at };
}

/** Read (and optionally drain) a mailbox within a family, keyed by `key`. */
export function recvFromFamily(
	familyId: string,
	key: string,
	payload: Record<string, unknown>,
): { messages: AgentMessage[] } {
	const family = familyStateFor(familyId);
	const mailbox = family.mailboxes.get(key) ?? [];
	if (payload.peek === true) return { messages: [...mailbox] };
	family.mailboxes.delete(key);
	return { messages: mailbox };
}

/** Roster of a family's parent + children. */
export function listAgentsInFamily(familyId: string): AgentFamilyRosterEntry[] {
	const family = familyStateFor(familyId);
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
	return roster;
}

// ---------------------------------------------------------------------------
// In-process session path (delegates to the primitives above)
// ---------------------------------------------------------------------------

/**
 * If `session` is an RLM child, return its `{ rlmChildId, familyKey }`;
 * otherwise `null`. A child is recognized purely by its `getAgentId()` being a
 * known `rlm_child_id`, so no spawn-path injection is required.
 */
function rlmChildContext(session: ToolSession): { rlmChildId: string; familyKey: string } | null {
	const agentId = session.getAgentId?.() ?? null;
	if (agentId && childToFamilyKey.has(agentId)) {
		return { rlmChildId: agentId, familyKey: childToFamilyKey.get(agentId)! };
	}
	return null;
}

/** The family key a session maps to (children resolve to their parent's family). */
export function familyKeyForSession(session: ToolSession): string {
	const child = rlmChildContext(session);
	if (child) return child.familyKey;
	return session.getSessionId?.() ?? "anon-rlm-family";
}

/** The relationship of `session` to its family (child if it is a known RLM child). */
export function callerRole(session: ToolSession): AgentFamilyRelationship {
	return rlmChildContext(session) ? "child" : "parent";
}

/** Resolve the family a session belongs to. Children resolve to their parent's family. */
export function familyFor(session: ToolSession): FamilyState {
	return familyStateFor(familyKeyForSession(session));
}

export function agentMessageListAgents(session: ToolSession): { agents: AgentFamilyRosterEntry[] } {
	return { agents: listAgentsInFamily(familyKeyForSession(session)) };
}

export function agentMessageSend(session: ToolSession, payload: Record<string, unknown>): AgentMessageReceipt {
	return sendToFamily(familyKeyForSession(session), callerRole(session), payload);
}

export function agentMessageRecv(session: ToolSession, payload: Record<string, unknown>): { messages: AgentMessage[] } {
	const child = rlmChildContext(session);
	// A child reads its own mailbox (keyed by its rlm_child_id); the parent reads "parent".
	const key = child ? child.rlmChildId : "parent";
	return recvFromFamily(familyKeyForSession(session), key, payload);
}
