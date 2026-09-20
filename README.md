# dsh-portage

Sync [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) sessions
with other tools — **one bidirectional plugin per tool**.

DSH is always one end of the link. This project never converts between two non-DSH
tools: there is no Codex → Kimi path, by design and by API shape.

| Plugin | Direction | Status |
| --- | --- | --- |
| [`dsh-portage-codex`](packages/codex) | Codex ↔ DSH | import available, export scaffolded |
| `dsh-portage-kimi` | Kimi ↔ DSH | planned |

## Install

```bash
dsh plugin --profile web add dsh-portage-codex
```

`dsh plugin add` runs pnpm in your profile and appends the package to
`dsh.profile.bundles` because it declares `dsh.bundle.patch`. **Restart `dsh web`
afterwards**: a running harness cannot swap an already-loaded plugin module
(Node caches ES modules by URL), so the new row only takes effect on the next boot.

Then configure your own patch layer (`~/.dsh/profiles/web/cordis.patch.yml`). The
insert row ships with the package, so you only write the config:

```yaml
- id: portage-codex
  config:
    import:
      sinceDays: 7          # only mirror rollouts touched in the last week (0 = all)
      autoCreateWorkspaces: false   # only import projects that already have a workspace
```

## What a plugin does

One plugin owns one external tool and both directions between it and DSH:

```
            ┌────────────── dsh-portage-codex ──────────────┐
            │  src/codex/read.js      src/codex/write.js  │   owns the Codex format
            └────────┬───────────────────────────┬────────┘
                 IR  │                           │  IR
        core/src/dsh/write.js           core/src/dsh/read.js    owns the DSH side
              (import  X → DSH)               (export  DSH → X)
```

`dsh-portage-core` owns the shared pipeline: the internal transcript representation,
the incremental pass, durable state, and the DSH session writer. A plugin supplies
its source adapter plus, once implemented, its export pass.

### Import (X → DSH)

- Scans the tool's session store and imports **complete turns only**; a turn still
  being written stays outside the consumed byte range and is picked up next pass.
- Appends to one DSH session per source session (`session-codex-<source id>`), from a
  durable byte offset, so re-runs never duplicate history.
- Writes through `sessionPersistence`, so artifact layout, compression, sequence
  contiguity, write leases and future format migrations remain DSH's job.
- Attaches each imported session to the workspace owning its recorded `cwd`.
- Folds each imported session's projections once, so its title appears in the
  sidebar immediately instead of falling back to the workspace name.
- Skips internal subagent rollouts, denied working directories, and (when
  `autoCreateWorkspaces` is off) projects without a workspace — re-checking those
  every `deferRetryMs`.
- Never writes to the source tool's store.

### Export (DSH → X)

Scaffolded: the config surface, state namespace and loop-prevention rules exist, and
`export.enabled` defaults to `false`. `dsh-portage-codex` will write DSH sessions back
through Codex's external-session import path.

Loop prevention is part of the design:

1. Sessions created by the import direction are never exported back to their own source.
2. Once such a session is continued inside DSH, only the turns past the import
   watermark are exported.
3. Export writes a *new* session in the target tool rather than rewriting the
   source artifact.

## Configuration

Every key lives under the direction it belongs to:

```yaml
- id: portage-codex
  config:
    enabled: true
    intervalMs: 60000          # one pass per minute
    startupDelayMs: 15000      # first pass after boot
    statePath: ''              # default: $DSH_HOME/dsh-portage/codex.json
    import:
      enabled: true
      sessionsDir: ''          # default: <codexHome>/sessions
      codexHome: ''            # default: ~/.codex
      includeArchived: false
      newestFirst: true
      autoCreateWorkspaces: true
      includeSubagentRollouts: false
      denyCwdIncludes: ['/.codex/worktrees/']
      minUserMessages: 1
      sinceDays: 0
      maxSessionsPerTick: 25
      maxFilesPerTick: 200
      maxReprojectPerTick: 200
      maxFileBytes: 0
      toolOutputMaxChars: 8000
      chunkBytes: 4194304
      maxChunkBytes: 67108864
      deferRetryMs: 21600000
      reimportDeleted: false
      agentPreset: standard
    export:
      enabled: false
      projectAllowlist: []
```

State lives in one document per tool (`$DSH_HOME/dsh-portage/codex.json`) with an
`import` and an `export` namespace. It is a durable cache, never an authority:
losing it costs a re-read, not correctness. Documents written by `dsh-portage-codex`
0.0.x (flat `{ version: 1, sessions }`) are migrated on load; an unknown version is
refused and the file is left untouched.

## Naming conventions

Contributions must keep these consistent — a plugin is never split by direction.

| Layer | Convention | Example |
| --- | --- | --- |
| repository | `dsh-portage` | — |
| npm package | `dsh-portage-<tool>`; the shared core is `dsh-portage-core` | `dsh-portage-codex` |
| plugin row id | package name without the `dsh-` prefix | `portage-codex` |
| entry | single entry, both directions inside | `lib/index.js` |
| config | direction as nested sections | `config.import.*`, `config.export.*` |
| external adapters | `src/<tool>/read.js`, `src/<tool>/write.js` | `src/codex/read.js` |
| DSH side | `core/src/dsh/{read,write}.js` | — |
| state | `$DSH_HOME/dsh-portage/<tool>.json` | `dsh-portage/codex.json` |
| docs | name both ends: “Codex → DSH” | — |

## Development

```bash
pnpm install
pnpm -r test      # 20 tests: parsers, pipeline, plugin wiring, real DSH round-trips
pnpm checkjs      # tsc --noEmit over JSDoc types
pnpm --filter dsh-portage-core pack
pnpm --filter dsh-portage-codex pack
```

The integration tests boot the **real** JSONL persistence backend into a temporary
root, run a full import, and then read the result back through
`Session.fromRestore(...).deriveMessages()` — the same path the harness uses — so a
change that stops producing valid DSH sessions fails in CI rather than in your
sidebar.

### Testing an install without publishing

Install the packed tarballs into a throwaway DSH home. Until `dsh-portage-core` is on
the registry, point the dependency at the local tarball with a pnpm override:

```bash
DSH_HOME=/tmp/dsh-scratch dsh plugin --profile web add /path/dsh-portage-core-0.1.0.tgz  # or an override
DSH_HOME=/tmp/dsh-scratch dsh --profile web --dump-config | grep -A2 'id: portage-codex'
```

## Compatibility

DSH ships release candidates, so the plugin declares the harness packages as peers
(`^0.1.5-rc.2`) and CI runs a nightly `compat` job that moves those peers to the
newest published line and re-runs the integration tests. Every DSH-internal
dependency lives behind `packages/core/src/dsh/` so a harness change lands in one
place.

## License

MIT. See [LICENSE](LICENSE).
