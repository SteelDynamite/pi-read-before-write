# pi-read-before-write

Pi package that blocks stale `edit` and destructive existing-file `write` operations when files changed since the agent last read them.

> Disclaimer: this is clanker slop. Use at your own risk.

## Why

This adds Claude Code-style stale-file protection to Pi without patching Pi core. It reduces accidental clobbers when a file is edited externally, by another agent, or by a parallel workflow after the current agent last read it.

## Install

From npm:

```bash
pi install npm:pi-read-before-write
```

From GitHub:

```bash
pi install git:github.com/SteelDynamite/pi-read-before-write
```

For project-local install:

```bash
pi install -l npm:pi-read-before-write
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
- Fingerprints and aliases are isolated per extension instance and cleared on every `session_start`, including new, resumed, forked, and reloaded sessions. Re-read files afterward.
- Filesystem inspection errors during mutation preflight fail the tool call instead of treating an unread existing file as new.
- Paths are resolved against Pi's current working directory, normalize Unicode spaces, strip a leading `@`, expand `~`, support `file://` URLs, and use `realpath()` when possible so symlink aliases share one fingerprint.

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
2. Protection is best-effort, not atomic. The preflight-to-mutation race remains. Separately, result-time hashing after `read`, `edit`, or `write` can trust external changes that the agent never saw. There is no pre/post-read certification or proof that mutation output matches the recorded bytes.
3. Fingerprints are in memory and are lost on restart or session start; re-read files before editing. Within-session tree navigation does not reset them.
4. Multiple Pi processes do not share fingerprint state.
5. Large files are hashed in full.
6. Fingerprints can be evicted from the bounded LRU cache; evicted existing files must be read again before editing. Auxiliary alias metadata is not bounded. Eviction, failed fingerprint refreshes, and unresolved symlink aliases can lose deletion history and permit recreation.
7. Windows shell-style drive paths (`/c/...`, `/mnt/c/...`, `/cygdrive/c/...`) can resolve differently from Pi and bypass the intended target check. Use native Windows paths instead.
8. Pi's alternative-filename read fallbacks may succeed without recording a fingerprint; custom/remote read implementations are not validated.

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:pack
npm run audit:release
npm run build
```

The package has no runtime npm dependencies; it uses Pi's extension API structurally and keeps its file-mutation queues locally. Queue cleanup handles rejected operations without changing queue keys or serialization. Regression tests cover session isolation/reset, in-flight result ownership, filesystem failures, queue cleanup/rejection recovery, and same-file serialization.

The implementation lives in `src/index.ts`. The original design notes are in [docs/PLAN.md](docs/PLAN.md).

## License

MIT
