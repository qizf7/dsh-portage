/**
 * The Codex half of `dsh-portage-codex`: assemble the rollout parser, the on-disk
 * discovery rules, and the session index into the pipeline's source adapter.
 *
 * @module dsh-portage-codex/codex/adapter
 */

import { detectDialect, parseRollout } from './read.js';
import { classifyRollout, discoverRollouts, readThreadNames, resolveTitle } from './pending.js';

/**
 * Create the Codex source adapter.
 * @param {Record<string, unknown>} config - resolved import config.
 * @returns {import('dsh-portage-core').SourceAdapter} the adapter.
 */
export function createCodexSource(config) {
  return {
    id: 'codex',
    discover: (root) => discoverRollouts(root),
    classify: (path, importConfig) => classifyRollout(path, importConfig),
    detectDialect,
    parseChunk: (buffer, dialect) => {
      const parsed = parseRollout(buffer, { dialect: /** @type {'items' | 'legacy'} */ (dialect) });
      return {
        turns: parsed.turns.map((turn) => ({
          id: String(turn.id ?? ''),
          settled: turn.complete === true,
          items: turn.items ?? [],
        })),
        consumedBytes: parsed.consumedBytes,
        meta: parsed.meta,
      };
    },
    index: () => readThreadNames(String(config.codexHome ?? '')),
    title: ({ turns, index, key }) => resolveTitle({ turns, index, key }),
  };
}
