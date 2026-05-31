import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
const config = {
    requireReadBeforeEdit: true,
    requireReadBeforeExistingWrite: true,
    allowNewFileWriteWithoutRead: true,
    hashAlgorithm: "sha256",
    maxFingerprints: 100,
    maxFingerprintBytes: 1024 * 1024,
};
class FingerprintCache {
    maxEntries;
    maxBytes;
    entries = new Map();
    totalBytes = 0;
    constructor(maxEntries, maxBytes) {
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
    }
    get(key) {
        const value = this.entries.get(key);
        if (!value)
            return undefined;
        this.entries.delete(key);
        this.entries.set(key, value);
        return value;
    }
    set(key, value) {
        const existing = this.entries.get(key);
        if (existing) {
            this.totalBytes -= fingerprintSize(existing);
            this.entries.delete(key);
        }
        this.entries.set(key, value);
        this.totalBytes += fingerprintSize(value);
        this.evictIfNeeded();
    }
    delete(key) {
        const existing = this.entries.get(key);
        if (!existing)
            return;
        this.totalBytes -= fingerprintSize(existing);
        this.entries.delete(key);
    }
    evictIfNeeded() {
        while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
            const oldest = this.entries.entries().next().value;
            if (!oldest)
                break;
            const [key, value] = oldest;
            this.totalBytes -= fingerprintSize(value);
            this.entries.delete(key);
        }
    }
}
function fingerprintSize(fingerprint) {
    return (Buffer.byteLength(fingerprint.path) +
        Buffer.byteLength(fingerprint.displayPath) +
        Buffer.byteLength(fingerprint.hash) +
        16);
}
const fingerprints = new FingerprintCache(config.maxFingerprints, config.maxFingerprintBytes);
const absolutePathAliases = new Map();
const localQueues = new Map();
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function normalizeToolPath(inputPath) {
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
function resolveAbsolutePath(inputPath, cwd) {
    const cleaned = normalizeToolPath(inputPath);
    return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
}
export async function resolveTrackedPath(inputPath, cwd) {
    const absolute = resolveAbsolutePath(inputPath, cwd);
    try {
        return await fs.realpath(absolute);
    }
    catch {
        return absolute;
    }
}
function getFingerprint(trackedPath, absolutePath) {
    return fingerprints.get(trackedPath) ?? fingerprints.get(absolutePathAliases.get(absolutePath) ?? "");
}
async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function hashFile(filePath) {
    const bytes = await fs.readFile(filePath);
    return {
        hash: createHash(config.hashAlgorithm).update(bytes).digest("hex"),
        size: bytes.byteLength,
    };
}
async function recordFingerprint(inputPath, cwd) {
    const absolutePath = resolveAbsolutePath(inputPath, cwd);
    const trackedPath = await resolveTrackedPath(inputPath, cwd);
    try {
        const { hash, size } = await hashFile(trackedPath);
        const fingerprint = {
            path: trackedPath,
            displayPath: inputPath,
            hash,
            size,
            recordedAt: Date.now(),
        };
        fingerprints.set(trackedPath, fingerprint);
        absolutePathAliases.set(absolutePath, trackedPath);
        return fingerprint;
    }
    catch {
        fingerprints.delete(trackedPath);
        const alias = absolutePathAliases.get(absolutePath);
        if (alias)
            fingerprints.delete(alias);
        absolutePathAliases.delete(absolutePath);
        return undefined;
    }
}
function queueByPath(trackedPath, fn) {
    const previous = localQueues.get(trackedPath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    localQueues.set(trackedPath, current.finally(() => {
        if (localQueues.get(trackedPath) === current) {
            localQueues.delete(trackedPath);
        }
    }));
    return current;
}
async function queuedFileOperation(trackedPath, fn) {
    return withFileMutationQueue(trackedPath, () => queueByPath(trackedPath, fn));
}
function getPathInput(event) {
    return typeof event.input.path === "string" ? event.input.path : undefined;
}
async function guardFreshness(toolName, inputPath, cwd) {
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
            if (toolName === "edit" && !config.requireReadBeforeEdit)
                return undefined;
            if (toolName === "write" && !config.requireReadBeforeExistingWrite)
                return undefined;
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
export default function readBeforeWrite(pi) {
    pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "edit" && event.toolName !== "write")
            return undefined;
        const inputPath = getPathInput(event);
        if (!inputPath)
            return undefined;
        return guardFreshness(event.toolName, inputPath, ctx.cwd);
    });
    pi.on("tool_result", async (event, ctx) => {
        if (event.isError)
            return undefined;
        if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write")
            return undefined;
        const inputPath = getPathInput(event);
        if (!inputPath)
            return undefined;
        const trackedPath = await resolveTrackedPath(inputPath, ctx.cwd);
        await queuedFileOperation(trackedPath, () => recordFingerprint(inputPath, ctx.cwd));
        return undefined;
    });
}
//# sourceMappingURL=index.js.map