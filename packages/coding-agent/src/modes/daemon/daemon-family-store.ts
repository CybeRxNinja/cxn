/**
 * Daemon family-store handler — the authoritative server side.
 *
 * This is the single source of truth for a family's registry + mailboxes when
 * the daemon is running: every `omp agents` client (and any future
 * daemon-backed child kernel) talks to this handler. Messaging delegates to the
 * same primitives as the in-process path in family-store.ts (so in-process and
 * daemon behavior stay identical), while the spawn topology lives in the
 * `RlmSpawnLedger` and session ownership in the `SessionLeaseRegistry`.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentMessage,
	deleteSubagentInFamily,
	getMailboxMap,
	listAgentsInFamily,
	type RlmSubagentRegistryEntry,
	recvFromFamily,
	registerChildInFamily,
	restoreMailboxMessages,
	sendToFamily,
} from "../../eval/py/family-store";
import { findCatalogModels } from "../../eval/py/rlm";
import type { DaemonFrom, DaemonRequestEnvelope, DaemonResponseEnvelope } from "./daemon-protocol";
import { HeartbeatCatalog } from "./heartbeat-catalog";
import { RlmSpawnLedger } from "./rlm-ledger";
import { SessionLeaseRegistry } from "./session-lease";

function defaultAgentDir(): string {
	const base = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
	return path.join(base, "omp", "daemon");
}

/** The daemon's topology authority (spawn edges) — shared across all connections. */
const ledger = new RlmSpawnLedger();
/** Session-ownership registry for attach/stop. */
let leaseRegistry: SessionLeaseRegistry | null = null;
/** Last-seen timestamps for agents; the heartbeat loop reaps stale ones. */
const heartbeatCatalog = new HeartbeatCatalog();
/** Repeating heartbeat timer handle (daemon-only). */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
/** Durable ledger snapshot path (Phase 6 persistence). */
let ledgerFile: string | null = null;
/** Durable mailbox directory (Phase 6 persistence). */
let mailboxDir: string | null = null;

function ensureLeaseRegistry(): SessionLeaseRegistry {
	if (!leaseRegistry) leaseRegistry = new SessionLeaseRegistry(defaultAgentDir());
	return leaseRegistry;
}

/** Persist the ledger snapshot to disk (no-op until setupDaemonState ran). */
function persistLedger(): void {
	if (ledgerFile) ledger.persist(ledgerFile);
}

/** Persist a family's mailboxes to disk (no-op until setupDaemonState ran). */
function persistMailboxes(familyId: string): void {
	if (!mailboxDir) return;
	const map = getMailboxMap(familyId);
	const obj: Record<string, AgentMessage[]> = {};
	for (const [key, messages] of map) obj[key] = messages;
	const file = path.join(mailboxDir, `${familyId}.json`);
	const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
	fs.writeFileSync(
		tmp,
		`${JSON.stringify(obj)}
`,
	);
	fs.renameSync(tmp, file);
}

/** Reload all persisted mailboxes into the in-memory family store (daemon boot). */
function loadAllMailboxes(): void {
	if (!mailboxDir) return;
	let files: string[];
	try {
		files = fs.readdirSync(mailboxDir);
	} catch {
		return;
	}
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		const familyId = f.slice(0, -".json".length);
		try {
			const obj = JSON.parse(fs.readFileSync(path.join(mailboxDir, f), "utf8")) as Record<string, AgentMessage[]>;
			for (const [key, messages] of Object.entries(obj)) {
				restoreMailboxMessages(familyId, key, messages);
			}
		} catch {
			/* corrupt mailbox file — skip */
		}
	}
}

/** Initialize daemon-side state. Call once at boot (or per test) with a writable dir. */
export function setupDaemonState(opts: { agentDir: string }): void {
	ledger.reset();
	leaseRegistry = new SessionLeaseRegistry(opts.agentDir);
	heartbeatCatalog.reset();
	stopDaemonHeartbeat();
	ledgerFile = path.join(opts.agentDir, "rlm-ledger.json");
	mailboxDir = path.join(opts.agentDir, "mailboxes");
	fs.mkdirSync(mailboxDir, { recursive: true, mode: 0o700 });
	// Reload durable state so a restarted daemon resumes where it left off.
	if (fs.existsSync(ledgerFile)) {
		try {
			ledger.loadJSON(JSON.parse(fs.readFileSync(ledgerFile, "utf8")));
		} catch {
			/* corrupt snapshot — start fresh */
		}
	}
	try {
		leaseRegistry.reload();
	} catch {}
	loadAllMailboxes();
}

/** Reset daemon-side state (topology + lease tables). Test-only convenience. */
export function resetDaemonState(): void {
	ledger.reset();
	leaseRegistry?.reset();
	heartbeatCatalog.reset();
	stopDaemonHeartbeat();
	ledgerFile = null;
	mailboxDir = null;
}

function ownerIdFor(from: DaemonFrom): string {
	return from.role === "child" && from.childId ? from.childId : "parent";
}

/** Handle one daemon request against the authoritative family store. Never throws. */
export async function handleDaemonRequest(req: DaemonRequestEnvelope): Promise<DaemonResponseEnvelope> {
	try {
		const { familyId, from, command, payload } = req;
		heartbeatCatalog.touch(familyId);
		if (from.role === "child" && from.childId) heartbeatCatalog.touch(from.childId);
		let result: unknown;
		switch (command) {
			case "agent_message.send":
				result = sendToFamily(familyId, { role: from.role, childId: from.childId }, payload);
				persistMailboxes(familyId);
				break;
			case "agent_message.recv": {
				// A child reads its own mailbox (keyed by its rlm_child_id); parent reads "parent".
				const key = from.role === "child" && from.childId ? from.childId : "parent";
				result = recvFromFamily(familyId, key, payload);
				persistMailboxes(familyId);
				break;
			}
			case "agent_message.list":
				result = { agents: listAgentsInFamily(familyId) };
				break;
			case "rlm.register_child": {
				const entry = payload.entry as RlmSubagentRegistryEntry;
				registerChildInFamily(familyId, entry);
				// The ledger is the topology authority: record the spawn edge.
				ledger.recordSpawn({
					parentId: familyId,
					childId: entry.rlm_child_id,
					name: entry.session_name,
					sessionId: entry.session_id,
				});
				heartbeatCatalog.touch(entry.rlm_child_id);
				persistLedger();
				result = { registered: entry.rlm_child_id };
				break;
			}
			case "rlm.list_subagents":
				// Read from the ledger (the topology authority), mapped to the registry shape.
				result = {
					subagents: ledger.childrenOf(familyId).map(e => ({
						rlm_child_id: e.childId,
						active_session_id: null,
						session_id: e.sessionId,
						session_name: e.name,
						session_dir: e.sessionDir ?? "",
						status: e.status,
					})),
				};
				break;
			case "rlm.delete_subagent": {
				const target = String(payload.target ?? "");
				result = deleteSubagentInFamily(familyId, target);
				ledger.remove(target);
				persistLedger();
				break;
			}
			case "find_models":
				result = { models: findCatalogModels(payload) };
				break;
			case "session.list":
				result = { agents: listAgentsInFamily(familyId) };
				break;
			case "session.attach": {
				const sessionDir = typeof payload.session_dir === "string" ? payload.session_dir : undefined;
				if (!sessionDir) throw new Error("session.attach requires session_dir");
				const lease = await ensureLeaseRegistry().acquire(sessionDir, ownerIdFor(from));
				result = { attached: true, sessionPath: lease.sessionPath, token: lease.token };
				break;
			}
			case "session.stop": {
				const sessionDir = typeof payload.session_dir === "string" ? payload.session_dir : undefined;
				if (!sessionDir) throw new Error("session.stop requires session_dir");
				const released = await ensureLeaseRegistry().release(sessionDir, ownerIdFor(from));
				result = { released };
				break;
			}
			default:
				throw new Error(`unknown daemon command: ${command}`);
		}
		return { id: req.id, ok: true, result };
	} catch (e) {
		return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Reap agents whose heartbeat is older than `ttlMs`: mark their ledger
 * edges completed and release any held session lease so the slot frees up.
 * Returns the reaped child ids.
 */
export function reapStaleAgents(ttlMs: number): string[] {
	const stale = heartbeatCatalog.staleIds(ttlMs);
	const reaped: string[] = [];
	for (const id of stale) {
		// Only reap child subagents, not the parent family root.
		const parent = ledger.parentOf(id);
		if (parent !== undefined) {
			ledger.setStatus(id, "completed");
			// Release the session lease keyed by this child's session dir.
			const edge = ledger.childrenOf(parent).find(e => e.childId === id);
			if (edge?.sessionDir) ensureLeaseRegistry().forceRelease(edge.sessionDir);
			reaped.push(id);
		}
		heartbeatCatalog.remove(id);
	}
	persistLedger();
	return reaped;
}

export interface DaemonHeartbeatOptions {
	/** How often to run the reaper, in ms. */
	intervalMs?: number;
	/** Inactivity threshold beyond which an agent is reaped, in ms. */
	ttlMs?: number;
}

/** Start the repeating heartbeat reaper. Idempotent — restarts if already running. */
export function startDaemonHeartbeat(opts: DaemonHeartbeatOptions = {}): void {
	stopDaemonHeartbeat();
	const intervalMs = opts.intervalMs ?? 15_000;
	const ttlMs = opts.ttlMs ?? 120_000;
	heartbeatTimer = setInterval(() => {
		try {
			reapStaleAgents(ttlMs);
		} catch {
			/* reaping must never crash the daemon loop */
		}
	}, intervalMs);
	// Don't keep the event loop alive solely for the heartbeat.
	if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
}

/** Stop the heartbeat reaper, if running. */
export function stopDaemonHeartbeat(): void {
	if (heartbeatTimer !== null) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
}
