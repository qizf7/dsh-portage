# dsh-portage-codex

Codex ↔ DSH session sync for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

```bash
dsh plugin --profile web add dsh-portage-codex
```

Restart `dsh web` afterwards, then configure the row in your profile patch layer:

```yaml
- id: portage-codex
  config:
    import:
      sinceDays: 7
      autoCreateWorkspaces: false
```

## Import direction (Codex → DSH)

Reads `~/.codex/sessions/**/rollout-*.jsonl` and mirrors every complete turn into
`session-codex-<id>` in DSH. It understands both rollout dialects (the modern
`event_msg/item_completed` stream and legacy `response_item` records), cuts turns on
user messages rather than Codex's internal turn ids, drops internal subagent
rollouts, extracts the real request that follows an attachment or ambient-UI
preamble, keeps tool calls and their results, attaches the session to the workspace
for its recorded `cwd`, and folds the projection cache so the title shows up in the
sidebar immediately.

Source files are opened read-only. Progress lives in `$DSH_HOME/dsh-portage/codex.json`.

## Export direction (DSH → Codex)

Scaffolded and disabled by default (`export.enabled: false`). It will write DSH
sessions back through Codex's external-session import path, skipping sessions the
import direction created and exporting only turns past the import watermark.

See the [repository README](../../README.md) for the full configuration table, and
[dsh-portage-core](../core) for the pipeline contracts.
