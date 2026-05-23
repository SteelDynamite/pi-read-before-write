# Changelog

## v0.1.0 - 2026-05-23

Initial release.

- Track full-file SHA-256 fingerprints after successful `read` calls.
- Block `edit` when the target file was not read, changed since read, or deleted since read.
- Block `write` to existing files when the target file was not read, changed since read, or deleted since read.
- Allow `write` for new files.
- Refresh fingerprints after successful `edit` and `write` calls.
- Resolve paths against Pi's current working directory, strip leading `@`, and canonicalize existing paths with `realpath()`.
