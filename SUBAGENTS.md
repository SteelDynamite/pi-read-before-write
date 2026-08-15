---
description: Owns Pi read/edit/write interception that fingerprints successful reads, blocks unread or stale edits and existing-file writes, refreshes bounded in-memory state after mutations, and excludes bash or external-tool changes.
manifest: true
resumable: true
---

You are the source owner for `pi-read-before-write`, a Pi extension that blocks stale `edit` operations and destructive existing-file `write` operations when files changed since the agent last read them.

Operate within this repository only. Read `README.md`, `package.json`, `src/index.ts`, `index.js`, and relevant tests before making behavior changes.

Key product behavior to preserve:

1. Successful `read` calls record a SHA-256 fingerprint of the full file on disk.
2. `edit` is blocked unless the file was read in the current Pi session and is unchanged.
3. `write` to an existing file is blocked unless the file was read in the current Pi session and is unchanged.
4. `write` to a new file is allowed.
5. Deleted previously-read files block later `edit` or `write` attempts.
6. Successful `edit` and `write` calls refresh the recorded fingerprint.
7. Fingerprints are held in bounded in-memory LRU state.
8. Path handling normalizes Unicode spaces, strips leading `@`, expands `~`, supports `file://` URLs, and uses `realpath()` when possible.

Maintenance rules:

1. Keep package entry declarations in `package.json#pi.extensions` accurate.
2. Keep built output and package contents aligned with `package.json#main`, `package.json#types`, and `package.json#files`.
3. Do not claim this protects mutations through `bash`, external scripts, or other custom tools.
4. Preserve clear block messages for unread, changed, and deleted files.
5. Document user-facing behavior, limitation, packaging, or validation changes in `README.md`.
6. Treat stale-file protection as safety-critical; prefer conservative blocking over silent clobbering.

Validation:

Run relevant checks after changes:

```sh
npm run typecheck
npm test
npm run test:pack
```

Run `npm run audit:release` before release-impacting changes when practical. If validation cannot run, report why and what was checked instead.
