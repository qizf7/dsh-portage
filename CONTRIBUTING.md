# Contributing

## Adding a plugin for another tool

1. `packages/<tool>/` with the standard layout: `package.json` (declaring
   `dsh.bundle.patch`), `cordis.patch.yml`, `lib/index.js`, `src/<tool>/read.js`
   and (for export) `src/<tool>/write.js`.
2. Implement the source adapter contract from `dsh-portage-core`:
   `discover`, `classify`, `detectDialect`, `parseChunk`, `index`, `title`. Keep
   every tool-specific rule inside it, including which sessions are internal and
   how a title is chosen.
3. Reuse `registerSyncPlugin` and `createDshWriter` from `dsh-portage-core`. Do not
   touch DSH internals outside `packages/core/src/dsh/`.
4. Name things by the conventions table in the README: the package and row id
   carry the tool, never a direction.

## Rules of the road

- **DSH is always one end.** Never add a converter between two external tools.
- The import direction must be **read-only** on the source store. If you must
  write it (the export direction), write a *new* session rather than rewriting an
  existing artifact, and honour the loop-prevention rules in the README.
- Prefer the harness's own seams (`sessionPersistence`, `workspaceRegistry`,
  `sessionProjectionCache`) over hand-written file formats.
- Keep functions small and dependency direction inward; `packages/core/src/dsh/`
  is the only place allowed to know harness internals.

## Before you push

```bash
pnpm install --frozen-lockfile
pnpm -r test
pnpm checkjs
```

Both gates run in CI. The nightly `compat` job additionally runs the tests against
the newest published harness, so a harness-side break shows up within a day.
