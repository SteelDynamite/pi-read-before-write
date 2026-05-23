import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

interface Fingerprint {
	path: string;
	displayPath: string;
	hash: string;
	size: number;
	recordedAt: number;
}

interface ToolEventWithPath {
	toolName: string;
	input: {
		path?: unknown;
	};
	isError?: boolean;
}

const config = {
	requireReadBeforeEdit: true,
	requireReadBeforeExistingWrite: true,
	allowNewFileWriteWithoutRead: true,
	hashAlgorithm: "sha256",
	maxFingerprints: 100,
	maxFingerprintBytes: 1024 * 1024,
} as const;

class FingerprintCache {
	private readonly entries = new Map<string, Fingerprint>();
	private totalBytes = 0;

	constructor(
		private readonly maxEntries: number,
		private readonly maxBytes: number,
	) {}

	get(key: string): Fingerprint | undefined {
		const value = this.entries.get(key);
		if (!value) return undefined;
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set(key: string, value: Fingerprint): void {
		const existing = this.entries.get(key);
		if (existing) {
			this.totalBytes -= fingerprintSize(existing);
			this.entries.delete(key);
		}

		this.entries.set(key, value);
		this.totalBytes += fingerprintSize(value);
		this.evictIfNeeded();
	}

	delete(key: string): void {
		const existing = this.entries.get(key);
		if (!existing) return;
		this.totalBytes -= fingerprintSize(existing);
		this.entries.delete(key);
	}

	private evictIfNeeded(): void {
		while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
			const oldest = this.entries.entries().next().value as [string, Fingerprint] | undefined;
			if (!oldest) break;
			const [key, value] = oldest;
			this.totalBytes -= fingerprintSize(value);
			this.entries.delete(key);
		}
	}
}

function fingerprintSize(fingerprint: Fingerprint): number {
	return (
		Buffer.byteLength(fingerprint.path) +
		Buffer.byteLength(fingerprint.displayPath) +
		Buffer.byteLength(fingerprint.hash) +
		16
	);
}

const fingerprints = new FingerprintCache(config.maxFingerprints, config.maxFingerprintBytes);
const localQueues = new Map<string, Promise<unknown>>();

export async function resolveTrackedPath(inputPath: string, cwd: string): Promise<string> {
	const cleaned = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
	const absolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
	try {
		return await fs.realpath(absolute);
	} catch {
		return absolute;
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function hashFile(filePath: string): Promise<{ hash: string; size: number }> {
	const bytes = await fs.readFile(filePath);
	return {
		hash: createHash(config.hashAlgorithm).update(bytes).digest("hex"),
		size: bytes.byteLength,
	};
}

async function recordFingerprint(inputPath: string, cwd: string): Promise<Fingerprint | undefined> {
	const trackedPath = await resolveTrackedPath(inputPath, cwd);
	try {
		const { hash, size } = await hashFile(trackedPath);
		const fingerprint: Fingerprint = {
			path: trackedPath,
			displayPath: inputPath,
			hash,
			size,
			recordedAt: Date.now(),
		};
		fingerprints.set(trackedPath, fingerprint);
		return fingerprint;
	} catch {
		fingerprints.delete(trackedPath);
		return undefined;
	}
}

function queueByPath<T>(trackedPath: string, fn: () => Promise<T>): Promise<T> {
	const previous = localQueues.get(trackedPath) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(fn);
	localQueues.set(
		trackedPath,
		current.finally(() => {
			if (localQueues.get(trackedPath) === current) {
				localQueues.delete(trackedPath);
			}
		}),
	);
	return current;
}

async function queuedFileOperation<T>(trackedPath: string, fn: () => Promise<T>): Promise<T> {
	return withFileMutationQueue(trackedPath, () => queueByPath(trackedPath, fn));
}

function getPathInput(event: ToolEventWithPath): string | undefined {
	return typeof event.input.path === "string" ? event.input.path : undefined;
}

async function guardFreshness(
	toolName: "edit" | "write",
	inputPath: string,
	cwd: string,
): Promise<{ block: true; reason: string } | undefined> {
	const trackedPath = await resolveTrackedPath(inputPath, cwd);
	return queuedFileOperation(trackedPath, async () => {
		const exists = await pathExists(trackedPath);
		const fingerprint = fingerprints.get(trackedPath);

		if (!exists) {
			if (fingerprint) {
				return {
					block: true,
					reason: `Blocked stale write: file was deleted since the last read: ${inputPath}`,
				};
			}
			if (toolName === "write" && config.allowNewFileWriteWithoutRead) {
				return undefined;
			}
		}

		if (!fingerprint) {
			if (toolName === "edit" && !config.requireReadBeforeEdit) return undefined;
			if (toolName === "write" && !config.requireReadBeforeExistingWrite) return undefined;
			return {
				block: true,
				reason: `Blocked stale write: file has not been read in this session. Read it before editing: ${inputPath}`,
			};
		}

		const current = await hashFile(trackedPath);
		if (current.hash !== fingerprint.hash || current.size !== fingerprint.size) {
			return {
				block: true,
				reason: `Blocked stale write: file changed on disk since the last read. Read it again before editing: ${inputPath}`,
			};
		}

		return undefined;
	});
}

export default function readBeforeWrite(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
		const inputPath = getPathInput(event);
		if (!inputPath) return undefined;

		const result = await guardFreshness(event.toolName, inputPath, ctx.cwd);
		if (result?.block && ctx.hasUI) {
			ctx.ui.notify(result.reason, "warning");
		}
		return result;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return undefined;
		if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return undefined;
		const inputPath = getPathInput(event);
		if (!inputPath) return undefined;

		const trackedPath = await resolveTrackedPath(inputPath, ctx.cwd);
		await queuedFileOperation(trackedPath, () => recordFingerprint(inputPath, ctx.cwd));
		return undefined;
	});
}
