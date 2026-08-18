/**
 * Daemon transport — newline-delimited JSON over a duplex byte stream.
 *
 * Two concrete transports are provided:
 *   - udsServer / udsConnect: real Unix-domain sockets via node:net
 *     (used by the supervisor daemon and cxn agents).
 *   - inMemoryPair: a connected in-memory duplex, used by tests so the full
 *     client<->server protocol is exercised deterministically without a socket.
 *
 * The higher-level DaemonClient correlates responses to requests by id.
 */

import * as fs from "node:fs/promises";
import * as net from "node:net";
import type { DaemonCommand, DaemonFrom, DaemonRequestEnvelope, DaemonResponseEnvelope } from "./daemon-protocol";

export type DaemonRequestHandler = (
	req: DaemonRequestEnvelope,
) => Promise<DaemonResponseEnvelope> | DaemonResponseEnvelope;

export interface DuplexStreams {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
}

interface ByteReader {
	read(): Promise<{ done: boolean | undefined; value?: Uint8Array }>;
	releaseLock(): void;
}

interface ByteWriter {
	write(chunk: Uint8Array): Promise<void>;
	close(): Promise<void>;
	releaseLock(): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Serve a single connection: read JSONL requests, dispatch, write JSONL responses. */
export async function serveConnection(streams: DuplexStreams, handler: DaemonRequestHandler): Promise<void> {
	const reader = streams.readable.getReader() as unknown as ByteReader;
	const writer = streams.writable.getWriter() as unknown as ByteWriter;
	let buf = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value ?? new Uint8Array());
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				if (!line.trim()) continue;
				const req = JSON.parse(line) as DaemonRequestEnvelope;
				const res = await handler(req);
				await writer.write(encoder.encode(`${JSON.stringify(res)}\n`));
			}
		}
	} finally {
		reader.releaseLock();
		writer.releaseLock();
	}
}

class MemoryPipe {
	readable: ReadableStream<Uint8Array>;
	#peer?: MemoryPipe;
	#controller!: ReadableStreamDefaultController<Uint8Array>;
	constructor() {
		this.readable = new ReadableStream({
			start: c => {
				this.#controller = c;
			},
		});
	}
	link(peer: MemoryPipe): void {
		this.#peer = peer;
	}
	get writable(): WritableStream<Uint8Array> {
		return new WritableStream({
			write: chunk => this.#peer?.enqueue(chunk),
			close: () => this.#peer?.closeReadable(),
		});
	}
	enqueue(chunk: Uint8Array): void {
		this.#controller.enqueue(chunk);
	}
	closeReadable(): void {
		try {
			this.#controller.close();
		} catch {
			/* already closed */
		}
	}
}

/** A connected in-memory duplex pair (server side + client side). For tests. */
export function inMemoryPair(): { server: DuplexStreams; client: DuplexStreams } {
	const serverPipe = new MemoryPipe();
	const clientPipe = new MemoryPipe();
	serverPipe.link(clientPipe);
	clientPipe.link(serverPipe);
	return {
		server: { readable: serverPipe.readable, writable: serverPipe.writable },
		client: { readable: clientPipe.readable, writable: clientPipe.writable },
	};
}

/** A DaemonClient speaks the protocol over an arbitrary duplex stream. */
export class DaemonClient {
	#reader: ByteReader;
	#writer: ByteWriter;
	#buf = "";
	#seq = 0;
	#pending = new Map<string, { resolve: (r: DaemonResponseEnvelope) => void; reject: (e: unknown) => void }>();

	constructor(streams: DuplexStreams) {
		this.#reader = streams.readable.getReader() as unknown as ByteReader;
		this.#writer = streams.writable.getWriter() as unknown as ByteWriter;
		void this.#pump();
	}

	async #pump(): Promise<void> {
		try {
			while (true) {
				const { done, value } = await this.#reader.read();
				if (done) break;
				this.#buf += decoder.decode(value ?? new Uint8Array());
				for (let i = this.#buf.indexOf("\n"); i >= 0; i = this.#buf.indexOf("\n")) {
					const line = this.#buf.slice(0, i);
					this.#buf = this.#buf.slice(i + 1);
					if (!line.trim()) continue;
					const res = JSON.parse(line) as DaemonResponseEnvelope;
					const p = this.#pending.get(res.id);
					if (p) {
						this.#pending.delete(res.id);
						p.resolve(res);
					}
				}
			}
		} catch (e) {
			for (const p of this.#pending.values()) p.reject(e);
			this.#pending.clear();
		}
	}

	async request(
		command: DaemonCommand,
		payload: Record<string, unknown>,
		from: DaemonFrom = { role: "parent" },
		familyId = "default",
	): Promise<unknown> {
		const id = `c${++this.#seq}`;
		const req: DaemonRequestEnvelope = { id, familyId, from, command, payload };
		const res = await new Promise<DaemonResponseEnvelope>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#writer.write(encoder.encode(`${JSON.stringify(req)}\n`)).catch(reject);
		});
		if (!res.ok) throw new Error(res.error ?? "daemon request failed");
		return res.result;
	}

	async close(): Promise<void> {
		try {
			await this.#writer.close();
		} catch {
			/* already closed */
		}
	}
}

function socketToStreams(sock: net.Socket): DuplexStreams {
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			sock.on("data", (d: Buffer) => controller.enqueue(new Uint8Array(d)));
			sock.on("end", () => {
				try {
					controller.close();
				} catch {
					/* noop */
				}
			});
			sock.on("error", e => controller.error(e));
		},
	});
	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise<void>((resolve, reject) => {
				sock.write(chunk, err => (err ? reject(err) : resolve()));
			});
		},
		close() {
			sock.end();
		},
		abort() {
			sock.destroy();
		},
	});
	return { readable, writable };
}

/** Start a Unix-domain-socket server serving handler. Removes any stale socket first. */
export async function udsServer(
	socketPath: string,
	handler: DaemonRequestHandler,
): Promise<{ socketPath: string; stop: () => Promise<void> }> {
	try {
		await fs.unlink(socketPath);
	} catch {
		/* not present */
	}
	const sockets = new Set<net.Socket>();
	let closed = false;
	const server = net.createServer(sock => {
		sockets.add(sock);
		sock.on("close", () => sockets.delete(sock));
		void serveConnection(socketToStreams(sock), handler).catch(() => {});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => resolve());
	});
	return {
		socketPath,
		stop: async () => {
			if (closed) return;
			closed = true;
			for (const s of sockets) s.destroy();
			sockets.clear();
			await new Promise<void>(resolve => server.close(() => resolve()));
			try {
				await fs.unlink(socketPath);
			} catch {
				/* already gone */
			}
		},
	};
}

/** Connect a DaemonClient to a Unix-domain socket. */
export async function udsConnect(socketPath: string): Promise<DaemonClient> {
	const sock = net.connect(socketPath);
	await new Promise<void>((resolve, reject) => {
		sock.once("error", reject);
		sock.once("connect", () => resolve());
	});
	return new DaemonClient(socketToStreams(sock));
}
