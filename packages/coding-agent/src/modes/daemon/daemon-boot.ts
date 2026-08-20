/**
 * Daemon boot — the real, long-running supervisor process.
 *
 * `omp` spawns this via `cli.ts --mode daemon --daemon-socket <path>`
 * (see daemon-supervisor.ts `spawnCliDaemon`). It:
 *   - initializes the authoritative family store + lease tables,
 *   - serves the JSONL protocol over a Unix-domain socket,
 *   - runs the heartbeat reaper that reclaims stale agents/leases,
 *   - cleans up its socket + lockfile on crash, signal, or normal exit.
 */

import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@cyberxninja-omp/pi-utils";
import {
	handleDaemonRequest,
	setupDaemonState,
	startDaemonHeartbeat,
	stopDaemonHeartbeat,
} from "./daemon-family-store";
import { removeDaemonLock } from "./daemon-socket";
import { udsServer } from "./daemon-transport";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TTL_MS = 120_000;

function defaultAgentDir(): string {
	const base = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
	return path.join(base, "omp", "daemon");
}

function parseSocketArg(argv: string[]): string {
	const i = argv.indexOf("--daemon-socket");
	if (i < 0 || i + 1 >= argv.length) {
		throw new Error("daemon boot requires --daemon-socket <path>");
	}
	return argv[i + 1];
}

/** Boot the supervisor daemon. Resolves only after the process is asked to exit. */
export async function runDaemonMode(argv: string[]): Promise<void> {
	const socketPath = parseSocketArg(argv);
	// Allow tests / operators to isolate the daemon's durable state dir.
	const agentDir = process.env.CXN_DAEMON_AGENT_DIR ?? defaultAgentDir();

	setupDaemonState({ agentDir });
	const server = await udsServer(socketPath, handleDaemonRequest);
	startDaemonHeartbeat({
		intervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
		ttlMs: DEFAULT_HEARTBEAT_TTL_MS,
	});

	logger.info("rlm daemon listening", { socketPath, agentDir });

	let shuttingDown = false;
	const cleanup = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		stopDaemonHeartbeat();
		await server.stop().catch(() => {});
		await removeDaemonLock(socketPath).catch(() => {});
	};

	const onError = (where: string, e: unknown): void => {
		logger.error("rlm daemon fatal", { where, error: e instanceof Error ? e.message : String(e) });
		void cleanup().finally(() => process.exit(1));
	};
	process.on("uncaughtException", e => onError("uncaughtException", e));
	process.on("unhandledRejection", e => onError("unhandledRejection", e));

	const onSignal = (sig: string): void => {
		logger.info("rlm daemon signal", { sig });
		void cleanup().finally(() => process.exit(0));
	};
	process.on("SIGINT", () => onSignal("SIGINT"));
	process.on("SIGTERM", () => onSignal("SIGTERM"));

	// Keep the process alive; the net server + listeners hold the event loop.
	await new Promise<void>(() => {});
}
