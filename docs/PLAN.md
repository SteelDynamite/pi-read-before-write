# Pi Read Before Write Extension Plan

## Goal

Add Claude Code-style stale-file protection to Pi without modifying core.

The extension should block `edit` and destructive `write` calls when the target file changed on disk since the agent last read it through Pi's `read` tool.

## Non-goals

- Do not patch Pi core.
- Do not prevent user edits generally.
- Do not parse or police arbitrary `bash` file mutations.
- Preserve same-file mutation serialization.
- Do not rely on timestamps alone.

## Desired behavior

1. Agent reads `foo.ts`.
2. Extension records a fingerprint of the full on-disk file.
3. Agent later calls `edit` or `write` on `foo.ts`.
4. Extension compares current on-disk fingerprint with recorded fingerprint.
5. If unchanged, allow the tool call.
6. If changed, block with a clear message:
   `File has changed since it was read. Read it again before attempting to write it: foo.ts`
7. After a successful Pi `edit` or `write`, update the recorded fingerprint to the new on-disk state.

## Rules

### Read tracking

On successful `read` tool result:

- Normalize the input path similarly to Pi core: normalize Unicode spaces, strip leading `@`, expand `~`, support `file://` URLs, then resolve against `ctx.cwd`.
- Canonicalize with `realpath()` when possible.
- Read raw bytes directly from disk.
- Store in a bounded LRU cache:
  - canonical path
  - SHA-256 hash
  - byte size
  - timestamp recorded
  - original tool path for display

Important: even if Pi's `read` output is truncated, the extension should hash the full file from disk.

### Edit guard

Before `edit`:

- Resolve and canonicalize target path.
- If target has no recorded fingerprint, block.
- If target no longer exists, block.
- If current hash differs from recorded hash, block.
- Otherwise allow.

After successful `edit`:

- Re-hash the file and update stored fingerprint.

### Write guard

Before `write`:

- If file does not exist, allow. This is a create.
- If file exists and no prior read fingerprint exists, block.
- If file exists and hash differs from recorded hash, block.
- If file exists and hash matches, allow.

After successful `write`:

- Re-hash the file and update stored fingerprint.

## Path handling

Current helper behavior:

- Normalize Unicode space variants to regular spaces.
- Strip a leading `@` from file paths.
- Expand `~` and `~/` to the user home directory.
- Convert `file://` URLs to file paths.
- Resolve relative paths against `ctx.cwd`.
- Use `realpath()` for existing files so symlink aliases share one fingerprint.
- For missing files, use resolved absolute path.

## Extension events

Use Pi extension hooks:

- `tool_result`
  - When `toolName === "read"` and not error: record fingerprint.
  - When `toolName === "edit" | "write"` and not error: update fingerprint.
- `tool_call`
  - When `toolName === "edit" | "write"`: validate freshness and possibly block.

## Parallel execution concerns

Pi runs sibling tool calls in parallel by default, but `tool_call` preflight is sequential. This extension should still keep its own per-path promise queue around guard/update logic to avoid interleaving extension state checks.

Use a small internal queue keyed by canonical path.

For guard correctness, the check must happen as close as possible to the tool execution. Since extension `tool_call` runs before core `edit`/`write`, there is still a small TOCTOU window before the built-in tool writes. This is acceptable for the extension prototype and should be documented.

## Settings

Initial hardcoded defaults:

```ts
const config = {
  requireReadBeforeEdit: true,
  requireReadBeforeExistingWrite: true,
  allowNewFileWriteWithoutRead: true,
  hashAlgorithm: "sha256",
  maxFingerprints: 100,
  maxFingerprintBytes: 1024 * 1024,
};
```

Optional later settings:

- Project config file: `.pi/read-before-write.json`
- Global config file: `~/.pi/agent/read-before-write.json`
- Path allowlist/denylist
- Disable guard for generated files
- Warn-only mode

## User-facing messages

No prior read:

```text
Blocked stale write: file has not been read in this session. Read it before editing: path/to/file.ts
```

Changed since read:

```text
Blocked stale write: file changed on disk since the last read. Read it again before editing: path/to/file.ts
```

Deleted since read:

```text
Blocked stale write: file was deleted since the last read: path/to/file.ts
```

## Limitations

1. Does not protect against `bash`, external scripts, or custom tools unless they also use this extension's APIs.
2. Cannot fully close the race between preflight and built-in write without core support.
3. In-memory state is intentionally lost on Pi restart; resumed sessions should re-read files before editing.
4. Multiple Pi processes do not share state.
5. Very large files require hashing full contents; acceptable for prototype, but may need max-size handling later.
6. The fingerprint cache is bounded; evicted files must be read again before editing.

## Test matrix

Automated tests cover:

1. Read file, edit file: allowed.
2. Edit file without read: blocked.
3. Read file, modify externally, edit: blocked.
4. Read file, modify externally, read again, edit: allowed.
5. Write new file without read: allowed.
6. Write existing file without read: blocked.
7. Read existing file, write it: allowed.
8. Read via symlink, edit via real path: should use same fingerprint.
9. Read with leading `@`, edit without it: allowed.
10. Read via `file://` URL, edit via normal path: allowed.
11. Unicode-space path normalization: allowed.
12. Successful edit updates fingerprint so another edit immediately after succeeds.
13. Successful write updates fingerprint so another write immediately after succeeds.
14. LRU eviction blocks editing an evicted file until it is read again.
15. LRU access refreshes recency.

## Upstream path

If the extension proves useful:

1. Open a Pi issue before PR.
2. Frame as stale/clobber protection, not Claude Code parity.
3. Propose either:
   - an opt-in core setting, or
   - smaller extension primitives to close gaps.
4. Mention known extension limitation: preflight cannot fully close TOCTOU window.
5. Include tests for CRLF, symlinks, external modification, and successful fingerprint refresh.

## Implementation outline

```ts
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

interface Fingerprint {
  path: string;
  displayPath: string;
  hash: string;
  size: number;
  recordedAt: number;
}

const fingerprints = new FingerprintCache(100, 1024 * 1024);

interface ExtensionAPI {
  on(name: "tool_call" | "tool_result", handler: Function): void;
}

export default function readBeforeWrite(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    // Resolve path, compare current fingerprint, return block if stale.
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (!["read", "edit", "write"].includes(event.toolName)) return;
    // Re-hash target path and update map.
  });
}
```
