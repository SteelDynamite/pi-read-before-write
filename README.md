# pi-read-before-write

Pi package that blocks stale `edit` and destructive existing-file `write` operations when files changed since the agent last read them.

> Disclaimer: this is clanker slop. Use at your own risk.

## Why

This adds Claude Code-style stale-file protection to Pi without patching Pi core. It reduces accidental clobbers when a file is edited externally, by another agent, or by a parallel workflow after the current agent last read it.

## Install

From npm:

```bash
pi install npm:pi-read-before-write@0.1.2
```

From GitHub:

```bash
pi install git:github.com/SteelDynamite/pi-read-before-write@v0.1.2
```

For project-local install:

```bash
pi install -l npm:pi-read-before-write@0.1.2
```

For local development/testing:

```bash
npm install
npm run build
pi -e ./dist/index.js
```

## Behavior

- Successful `read` calls record a SHA-256 fingerprint of the full file on disk.
- `edit` is blocked unless the file was read in the current Pi session and is unchanged.
- `write` to an existing file is blocked unless the file was read in the current Pi session and is unchanged.
- `write` to a new file is allowed.
- If a previously read file is deleted before `edit` or `write`, the operation is blocked.
- Successful `edit`/`write` calls refresh the recorded fingerprint.
- Fingerprints are held in a bounded LRU cache: 100 files or 1MB of fingerprint metadata, whichever is hit first.
- Paths are resolved against Pi's current working directory, strip a leading `@`, and use `realpath()` when possible so symlink aliases share one fingerprint.

## Block messages

Unread file:

```text
Blocked stale write: file has not been read in this session. Read it before editing: path/to/file.ts
```

Changed file:

```text
Blocked stale write: file changed on disk since the last read. Read it again before editing: path/to/file.ts
```

Deleted file:

```text
Blocked stale write: file was deleted since the last read: path/to/file.ts
```

## Limitations

1. It does not block file mutations through `bash`, external scripts, or other custom tools.
2. It cannot fully close the small race between extension preflight and Pi's built-in write execution without core support.
3. Fingerprints are in memory and are lost when Pi restarts; resumed sessions should re-read files before editing.
4. Multiple Pi processes do not share fingerprint state.
5. Large files are hashed in full.

## Development

```bash
npm install
npm run typecheck
npm run build
```

The implementation lives in `src/index.ts`. The original design notes are in [docs/PLAN.md](docs/PLAN.md).

## License

MIT
