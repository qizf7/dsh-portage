/**
 * The pipeline's internal transcript representation.
 *
 * This is **not** a public interchange format: every plugin pairs exactly one
 * external tool with DSH, so the IR only ever travels between that plugin's own
 * reader and DSH's reader/writer. It carries a version so a plugin can evolve
 * its reader without silently mismatching a writer.
 *
 * @module dsh-portage-core/ir
 */

/**
 * The slice of the cordis host context a sync plugin actually touches.
 *
 * Declared structurally rather than as `import('@deepseek-ai/cordis').Context`
 * so the core does not depend on service augmentations contributed by harness
 * packages it never installs.
 *
 * @typedef {object} SyncHost
 * @property {any} sessionPersistence - DSH session persistence service.
 * @property {{info: (message: string) => void, warn: (message: string) => void}} logger - host logger.
 * @property {(name: string) => any} get - optional service lookup.
 * @property {(fn: () => any, label?: string) => any} effect - fiber-scoped disposer registration.
 * @property {(fn: () => void, ms: number) => () => void} timeout - one-shot timer.
 * @property {(fn: () => void, ms: number) => () => void} interval - repeating timer.
 */

/** IR schema version understood by this build. */
export const IR_VERSION = 1;

/** Item kinds the pipeline understands. */
const ITEM_KINDS = new Set(['user', 'assistant', 'reasoning', 'tool', 'plan']);

/**
 * @typedef {'user' | 'assistant' | 'reasoning' | 'tool' | 'plan'} ItemKind
 */

/**
 * Tool payload of one tool item.
 *
 * @typedef {object} ToolPayload
 * @property {string} name - tool name as the source reported it.
 * @property {unknown} args - tool arguments, JSON-serializable.
 * @property {string} output - tool output text.
 * @property {boolean} isError - whether the source marked the call failed.
 */

/**
 * @typedef {object} Item
 * @property {ItemKind} kind - item kind.
 * @property {string} id - stable source identifier.
 * @property {string} [text] - text payload for user/assistant/reasoning/plan items.
 * @property {string} [phase] - source-reported phase such as `commentary`.
 * @property {ToolPayload} [tool] - tool payload for tool items.
 */

/**
 * @typedef {object} Turn
 * @property {string} id - source turn identifier.
 * @property {boolean} [settled] - whether the source reported the turn finished.
 * @property {Item[]} items - items in source order.
 */

/**
 * @typedef {object} SourceMeta
 * @property {string} [kind] - external tool name.
 * @property {string} [sessionId] - session id in the source tool.
 * @property {string} [cwd] - project directory recorded by the source.
 * @property {string} [provider] - model provider recorded by the source.
 * @property {string} [model] - model recorded by the source.
 * @property {string} [title] - human title recorded by the source.
 * @property {string} [source] - raw origin marker (used for skip decisions).
 */

/**
 * @typedef {object} Transcript
 * @property {number} irVersion - {@link IR_VERSION} of this transcript.
 * @property {SourceMeta} source - session-level metadata.
 * @property {Turn[]} turns - complete turns, in source order.
 */

/**
 * Create an empty transcript.
 * @param {SourceMeta} source - session-level metadata.
 * @returns {Transcript} a new transcript.
 */
export function createTranscript(source) {
  return { irVersion: IR_VERSION, source, turns: [] };
}

/**
 * Whether one item is a recognized IR item.
 * @param {unknown} item - candidate item.
 * @returns {boolean} whether the item is usable.
 */
export function isItem(item) {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (/** @type {Item} */ (item).kind) === 'string' &&
    ITEM_KINDS.has(/** @type {Item} */ (item).kind)
  );
}

/**
 * Count user-authored items across turns.
 * @param {Turn[]} turns - complete turns.
 * @returns {number} the user item count.
 */
export function countUserItems(turns) {
  return turns.reduce(
    (total, turn) => total + (turn.items ?? []).filter((item) => item.kind === 'user').length,
    0
  );
}

/**
 * First non-empty user text in a transcript, used as a fallback title.
 * @param {Turn[]} turns - complete turns.
 * @returns {string} the text, or an empty string.
 */
export function firstUserText(turns) {
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.kind !== 'user') continue;
      const text = String(item.text ?? '').replace(/\s+/g, ' ').trim();
      if (text.length > 0) return text;
    }
  }
  return '';
}

/**
 * Whether a path is absolute on the current platform.
 * @param {string} value - candidate path.
 * @returns {boolean} whether the value is an absolute path.
 */
export function isAbsolutePath(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}
