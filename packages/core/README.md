# dsh-portage-core

Shared pipeline behind every [`dsh-portage`](../..) plugin: the internal transcript
representation, the incremental pass, durable state, and the DSH session writer.

Plugins do not touch harness internals themselves — `src/dsh/` is the only place in
this project that knows how DSH stores sessions, so a harness change lands in one
file instead of every plugin.

## Contracts

- `SourceAdapter` (`./pipeline`) — one external tool's reader: `discover`,
  `classify`, `detectDialect`, `parseChunk`, `index`, `title`. It returns complete
  turns only and reports how many bytes were consumed.
- `TargetWriter` (`./pipeline`) — the DSH half: build events, build the session
  header, read the stored sequence length, write, attach a workspace, fold
  projections.
- `registerSyncPlugin` (`./runner`) — loads state, wires the pass loop, and runs the
  import direction; the export direction plugs in through `exportPass`.

## State

One document per tool (`$DSH_HOME/dsh-portage/<tool>.json`) with an `import` and an
`export` namespace, replaced atomically. Losing it costs a re-read, never
correctness. Documents from the earlier flat shape are migrated on load; an unknown
version is refused with the file left untouched.

## Guarantees the pipeline keeps

- Only complete source turns are consumed; a partial turn stays outside the
  recorded byte offset.
- Sequence numbers always continue from the target's actual stored length.
- A source that shrank is abandoned with a warning rather than duplicated.
- A target session deleted by the user is not resurrected.
- Failures are per source file: one bad file never stops a pass.
