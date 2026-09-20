# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Bidirectional plugin skeleton: one plugin per external tool, one entry, with
  `config.import.*` and `config.export.*` and a two-namespace state document.
- `dsh-portage-core`: transcript IR, incremental pass, durable state with a
  version-1 migration, scheduler, runner, and the DSH session writer.
- `dsh-portage-codex`: Codex → DSH import (both rollout dialects, turn boundaries on
  user messages, attachment-preamble cleanup, subagent skip, chunked reads,
  workspace attach, projection folding, deferral and deletion handling).
- Tests: parser units, pipeline integration against the real JSONL persistence
  backend, and plugin wiring through `apply()`.

### Fixed

- A source file that shrank (replaced or rotated) is abandoned with a warning
  instead of silently duplicating or blocking its session.

[Unreleased]: https://github.com/qizf7/dsh-portage/commits/main
