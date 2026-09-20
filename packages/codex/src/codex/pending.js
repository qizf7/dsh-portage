/**
 * Codex-specific discovery, classification, and titling.
 *
 * The rollout parser lives in `./read.js`; this module owns everything about how
 * Codex stores sessions on disk: file naming, the session index, which rollouts
 * are internal subagent runs, and how a session is titled.
 *
 * @module dsh-portage-codex/codex/pending
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText } from 'dsh-portage-core';
import { isSubagentSource, parseSessionMeta } from './read.js';

/** Bytes read to classify a rollout before importing it in full. */
export const CLASSIFY_BYTES = 256 * 1024;

/**
 * Extract the Codex session id from a rollout filename.
 * @param {string} filename - basename of the rollout.
 * @returns {string} the session id, or an empty string when unrecognized.
 */
export function sessionIdFromFilename(filename) {
  const stem = filename.replace(/\.jsonl$/, '');
  if (!stem.startsWith('rollout-')) return '';
  const after = stem.slice('rollout-'.length);
  return after.length > 20 && after[19] === '-' ? after.slice(20) : after;
}

/**
 * Walk a directory tree for rollout files.
 * @param {string} root - Codex sessions directory.
 * @returns {import('dsh-portage-core').SourceFile[]} discovered rollouts.
 */
export function discoverRollouts(root) {
  /** @type {import('dsh-portage-core').SourceFile[]} */
  const out = [];
  /** @param {string} dir - directory to walk. */
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (/** @type {{code?: string}} */ (error)?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      const key = sessionIdFromFilename(entry.name);
      if (key.length === 0) continue;
      try {
        const info = statSync(path);
        out.push({ path, key, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // A rollout that vanished mid-walk simply is not imported this pass.
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Read the first bytes of one rollout and classify it.
 * @param {string} path - rollout path.
 * @param {Record<string, unknown>} config - resolved import config.
 * @returns {{meta: import('dsh-portage-core').SourceMeta, skip?: string} | undefined} classification.
 */
export function classifyRollout(path, config) {
  const buffer = readHead(path, CLASSIFY_BYTES);
  const meta = parseSessionMeta(buffer);
  if (meta === undefined) return undefined;
  if (config.includeSubagentRollouts !== true && isSubagentSource(meta.source)) {
    return { meta, skip: 'subagent' };
  }
  return { meta };
}

/**
 * Read up to `length` bytes from the start of a file.
 * @param {string} path - file path.
 * @param {number} length - maximum bytes.
 * @returns {Buffer} the bytes actually read.
 */
function readHead(path, length) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read Codex's thread-name index.
 * @param {string} codexHome - Codex home directory.
 * @returns {Record<string, string>} thread names by session id.
 */
export function readThreadNames(codexHome) {
  /** @type {Record<string, string>} */
  const names = {};
  let raw;
  try {
    raw = readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return names;
  }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record.id === 'string' && typeof record.thread_name === 'string') {
        names[record.id] = record.thread_name;
      }
    } catch {
      // A malformed index row only costs one session its title.
    }
  }
  return names;
}

/**
 * Choose a title for one imported session.
 * @param {object} input - title inputs.
 * @param {import('dsh-portage-core').Turn[]} input.turns - complete turns.
 * @param {Record<string, string>} input.index - thread names by session id.
 * @param {string} input.key - session key.
 * @returns {string} the title.
 */
export function resolveTitle(input) {
  const named = input.index[input.key];
  if (typeof named === 'string' && named.trim().length > 0) return named.trim();
  const first = firstUserText(input.turns);
  if (first.length > 0) return first.slice(0, 80);
  return `Codex ${input.key.slice(0, 8)}`;
}
