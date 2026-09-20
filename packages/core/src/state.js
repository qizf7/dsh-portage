/**
 * Durable sync state shared by every direction of one plugin.
 *
 * One document per external tool (`$DSH_HOME/dsh-portage/<tool>.json`) with one
 * namespace per direction, so a bidirectional plugin keeps its import
 * watermarks and its export anchors in a single atomically replaced file.
 *
 * The document is a durable cache, never an authority: losing it costs a
 * re-read of already imported sources, never correctness, because every
 * imported session records its own consumed byte offset.
 *
 * @module dsh-portage-core/state
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

/** Current state document version. */
export const STATE_VERSION = 2;

/** Version of the flattened single-direction document this build migrates from. */
const LEGACY_STATE_VERSION = 1;

/**
 * Resolve the default state path for one external tool.
 * @param {string} tool - external tool name, e.g. `codex`.
 * @returns {string} absolute path of the state document.
 */
export function defaultStatePath(tool) {
  return dshHomePath('dsh-portage', `${tool}.json`);
}

/** @returns {Record<string, unknown>} an empty state document. */
export function emptyState() {
  return { version: STATE_VERSION, import: { sessions: {} }, export: { anchors: {} } };
}

/**
 * Wrap a version-1 document into the current two-namespace shape.
 * @param {Record<string, unknown>} document - legacy document.
 * @returns {Record<string, unknown>} the migrated document.
 */
export function migrateLegacyState(document) {
  return {
    version: STATE_VERSION,
    import: { sessions: document.sessions ?? {} },
    export: { anchors: {} },
  };
}

/**
 * Validate one parsed document, migrating a known legacy shape.
 * @param {unknown} parsed - parsed JSON value.
 * @returns {Record<string, unknown> | undefined} a usable document, or undefined.
 */
export function normalizeState(parsed) {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const document = /** @type {Record<string, unknown>} */ (parsed);
  if (document.version === LEGACY_STATE_VERSION) return migrateLegacyState(document);
  if (document.version !== STATE_VERSION) return undefined;
  if (typeof document.import !== 'object' || document.import === null) return undefined;
  if (typeof document.export !== 'object' || document.export === null) return undefined;
  const namespaced = /** @type {{import: Record<string, unknown>, export: Record<string, unknown>}} */ (document);
  if (typeof namespaced.import.sessions !== 'object' || namespaced.import.sessions === null) return undefined;
  if (typeof namespaced.export.anchors !== 'object' || namespaced.export.anchors === null) return undefined;
  return document;
}

/**
 * Load the state document, tolerating absence and corruption.
 * @param {string} path - state document path.
 * @param {(message: string) => void} [warn] - diagnostics sink.
 * @returns {Record<string, unknown>} the loaded or empty state.
 */
export function loadState(path, warn) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code !== 'ENOENT') {
      warn?.(`state unreadable at ${path}: ${String(error)}`);
    }
    return emptyState();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warn?.(`state at ${path} is not valid JSON: ${String(error)}`);
    return emptyState();
  }
  const normalized = normalizeState(parsed);
  if (normalized === undefined) {
    const version = typeof parsed === 'object' && parsed !== null ? /** @type {Record<string, unknown>} */ (parsed).version : undefined;
    warn?.(`state at ${path} has unsupported version ${String(version)}; refusing to guess (file left untouched)`);
    return emptyState();
  }
  return normalized;
}

/**
 * Persist the state document atomically.
 * @param {string} path - state document path.
 * @param {Record<string, unknown>} state - state to persist.
 * @returns {Promise<void>} resolution after durability.
 */
export async function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Read the sessions namespace of an import state.
 * @param {Record<string, unknown>} state - state document.
 * @returns {Record<string, Record<string, unknown>>} sessions by source key.
 */
export function importSessions(state) {
  const namespace = /** @type {{sessions: Record<string, Record<string, unknown>>}} */ (state.import);
  return namespace.sessions;
}

/**
 * Read the anchors namespace of an export state.
 * @param {Record<string, unknown>} state - state document.
 * @returns {Record<string, Record<string, unknown>>} anchors by exported session.
 */
export function exportAnchors(state) {
  const namespace = /** @type {{anchors: Record<string, Record<string, unknown>>}} */ (state.export);
  return namespace.anchors;
}
