# Changelog

## v0.1.2 - 2026-05-23

- Bound fingerprint tracking with a 100-entry / 1MB LRU cache.
- Add automated tests for stale writes, deletion handling, symlinks, leading `@` paths, fingerprint refresh, and LRU eviction/recency.

## v0.1.1 - 2026-05-23

- Use the compiled `dist/index.js` extension entrypoint for npm package installs.
- Include generated `dist` files in the repository and package so GitHub and npm installs use the same entrypoint.
- Add `prepack` build step before npm packing/publishing.
- Block `write` when the target was read earlier and then deleted before the write.

## v0.1.0 - 2026-05-23

Initial release.

- Track full-file SHA-256 fingerprints after successful `read` calls.
- Block `edit` when the target file was not read, changed since read, or deleted since read.
- Block `write` to existing files when the target file was not read, changed since read, or deleted since read.
- Allow `write` for new files.
- Refresh fingerprints after successful `edit` and `write` calls.
- Resolve paths against Pi's current working directory, strip leading `@`, and canonicalize existing paths with `realpath()`.
