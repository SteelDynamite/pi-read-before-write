import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ExtensionContext {
	cwd: string;
}

interface ExtensionAPI {
	on(name: "tool_call", handler: ExtensionHandler<ToolCallResult | undefined>): void;
	on(name: "tool_result", handler: ExtensionHandler<undefined>): void;
}

type ExtensionHandler<T> = (event: ToolEventWithPath, ctx: ExtensionContext) => T | Promise<T>;

interface ToolCallResult {
	block: true;
	reason: string;
}

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
const absolutePathAliases = new Map<string, string>();
const fileMutationQueues = new Map<string, Promise<void>>();
const localQueues = new Map<string, Promise<unknown>>();
let registrationQueue = Promise.resolve();
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeToolPath(inputPath: string): string {
	let normalized = inputPath.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (normalized === "~") {
		return os.homedir();
	}
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}
	return normalized;
}

function resolveAbsolutePath(inputPath: string, cwd: string): string {
	const cleaned = normalizeToolPath(inputPath);
	return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
}

export async function resolveTrackedPath(inputPath: string, cwd: string): Promise<string> {
	const absolute = resolveAbsolutePath(inputPath, cwd);
	try {
		return await fs.realpath(absolute);
	} catch {
		return absolute;
	}
}

function getFingerprint(trackedPath: string, absolutePath: string): Fingerprint | undefined {
	return fingerprints.get(trackedPath) ?? fingerprints.get(absolutePathAliases.get(absolutePath) ?? "");
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
	const absolutePath = resolveAbsolutePath(inputPath, cwd);
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
		absolutePathAliases.set(absolutePath, trackedPath);
		return fingerprint;
	} catch {
		fingerprints.delete(trackedPath);
		const alias = absolutePathAliases.get(absolutePath);
		if (alias) fingerprints.delete(alias);
		absolutePathAliases.delete(absolutePath);
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

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = path.resolve(filePath);
	try {
		return await fs.realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) return resolvedPath;
		throw error;
	}
}

async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(() => undefined, () => undefined);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
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
	const absolutePath = resolveAbsolutePath(inputPath, cwd);
	const trackedPath = await resolveTrackedPath(inputPath, cwd);
	return queuedFileOperation(trackedPath, async () => {
		const exists = await pathExists(trackedPath);
		const fingerprint = getFingerprint(trackedPath, absolutePath);

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

		return guardFreshness(event.toolName, inputPath, ctx.cwd);
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
