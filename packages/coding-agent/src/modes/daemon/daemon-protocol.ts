/**
 * Daemon protocol — the wire contract between `omp agents` (and future
 * daemon-backed child kernels) and the supervisor daemon.
 *
 * Framing: newline-delimited JSON (one `DaemonRequestEnvelope` per line, one
 * `DaemonResponseEnvelope` per line). Each request carries a `familyId` (the
 * family this connection belongs to) and a `from` identity (role + optional
 * child id), so the daemon — the authoritative family store — can address the
 * correct family and mailbox without inferring it from a process.
 */

export type DaemonRole = "parent" | "child";

export type DaemonCommand =
	| "agent_message.send"
	| "agent_message.recv"
	| "agent_message.list"
	| "rlm.register_child"
	| "rlm.list_subagents"
	| "rlm.delete_subagent"
	| "find_models"
	| "session.list"
	| "session.attach"
	| "session.stop";

export interface DaemonFrom {
	role: DaemonRole;
	/** Present when `role === "child"`; the `rlm_child_id` this connection speaks for. */
	childId?: string;
}

export interface DaemonRequestEnvelope {
	id: string;
	familyId: string;
	from: DaemonFrom;
	command: DaemonCommand;
	payload: Record<string, unknown>;
}

export interface DaemonResponseEnvelope {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}
