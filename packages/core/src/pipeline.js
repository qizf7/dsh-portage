/**
 * The direction-agnostic incremental pipeline.
 *
 * A plugin always pairs exactly one external tool with DSH, so the pipeline is
 * constructed from two halves — a {@link SourceAdapter} that owns the external
 * format and a {@link TargetWriter} that owns the DSH side — plus the durable
 * state document. Composing two external adapters is not expressible: the
 * pipeline only ever knows one external tool.
 *
 * @module dsh-portage-core/pipeline
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { countUserItems } from './ir.js';
import { importSessions } from './state.js';

/** First chunk size attempted when reading a source file. */
export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Ceiling for one chunk, so a single huge turn cannot exhaust memory. */
export const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * @typedef {object} SourceFile
 * @property {string} path - absolute file path.
 * @property {string} key - session key inside the external tool.
 * @property {number} size - current size in bytes.
 * @property {number} mtimeMs - modification time.
 */

/**
 * @typedef {object} ParsedChunk
 * @property {import('./ir.js').Turn[]} turns - complete turns only.
 * @property {number} consumedBytes - bytes the next pass resumes after.
 * @property {import('./ir.js').SourceMeta} [meta] - metadata found in this chunk.
 */

/**
 * One external tool's reader half. Everything format-specific lives here.
 *
 * @typedef {object} SourceAdapter
 * @property {string} id - external tool name, e.g. `codex`.
 * @property {(root: string) => SourceFile[]} discover - list candidate files under one root.
 * @property {(path: string, config: Record<string, unknown>) => {meta: import('./ir.js').SourceMeta, skip?: string} | undefined} classify - cheap header-only classification.
 * @property {(buffer: Buffer) => string} detectDialect - pick the physical dialect of a chunk.
 * @property {(buffer: Buffer, dialect: string) => ParsedChunk} parseChunk - parse complete turns from a chunk.
 * @property {() => Record<string, string>} index - human titles by session key, refreshed per pass.
 * @property {(input: {turns: import('./ir.js').Turn[], meta: import('./ir.js').SourceMeta, key: string, index: Record<string, string>}) => string} title - display title for one session.
 */

/**
 * The DSH half. Every DSH-internal dependency of the pipeline hides behind it.
 *
 * @typedef {object} TargetWriter
 * @property {string} id - target id, always `dsh`.
 * @property {(sourceKey: string) => string} sessionKey - DSH session id for one source session.
 * @property {(input: {turns: import('./ir.js').Turn[], startSeq: number, startTurn: number, sessionKey: string, meta: import('./ir.js').SourceMeta, toolOutputMaxChars: number, title?: string}) => {events: Record<string, unknown>[], nextSeq: number, nextTurn: number, firstUserSeq?: number}} buildEvents
 * @property {(input: {sessionKey: string, createdAt: number, meta: import('./ir.js').SourceMeta, agentPreset: string}) => Record<string, unknown>} buildHeader
 * @property {(sessionKey: string, fallbackSeq: number) => Promise<number | undefined>} nextSeq
 * @property {(header: Record<string, unknown>, create: boolean, events: Record<string, unknown>[]) => Promise<void>} write
 * @property {(cwd: string) => Promise<boolean | undefined>} canAttach
 * @property {(sessionKey: string) => Promise<boolean>} project
 */

/**
 * Read one bounded slice of a file.
 * @param {string} path - file path.
 * @param {number} offset - first byte to read.
 * @param {number} length - maximum bytes to read.
 * @returns {Buffer} the bytes actually read.
 */
function readSlice(path, offset, length) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read and parse the pending bytes of one source file, growing the chunk until
 * at least one complete turn (or end of file) is available.
 *
 * @param {object} input - read inputs.
 * @param {SourceAdapter} input.source - source adapter.
 * @param {string} input.path - source file path.
 * @param {number} input.offset - first unconsumed byte.
 * @param {number} input.size - current file size.
 * @param {string | undefined} input.dialect - known dialect, detected when absent.
 * @param {number} input.chunkBytes - first chunk size.
 * @param {number} input.maxChunkBytes - largest chunk to attempt.
 * @returns {ParsedChunk & {dialect: string} | undefined} parse result.
 */
export function readPendingTurns(input) {
  let chunkBytes = Math.max(64 * 1024, input.chunkBytes);
  while (chunkBytes <= input.maxChunkBytes) {
    const remaining = input.size - input.offset;
    const want = Math.min(chunkBytes, Math.max(remaining, 0));
    if (want <= 0) return undefined;
    const buffer = readSlice(input.path, input.offset, want);
    if (buffer.length === 0) return undefined;
    const dialect = input.dialect ?? input.source.detectDialect(buffer);
    const parsed = input.source.parseChunk(buffer, dialect);
    if (parsed.turns.length > 0 && parsed.consumedBytes > 0) {
      return { ...parsed, dialect };
    }
    if (input.offset + buffer.length >= input.size) return undefined;
    chunkBytes *= 2;
  }
  return undefined;
}

/**
 * Decide whether one not-yet-imported file can be skipped without reading its
 * body: source-classified skips, denied working directories, and projects that
 * have no DSH workspace when automatic creation is off.
 *
 * @param {object} input - decision inputs.
 * @param {SourceAdapter} input.source - source adapter.
 * @param {TargetWriter} input.target - target writer.
 * @param {Record<string, unknown>} input.config - resolved import config.
 * @param {Record<string, any> | undefined} input.entry - recorded progress.
 * @param {SourceFile} input.file - discovered file.
 * @returns {Promise<Record<string, any> | undefined>} a skip result, or undefined to continue.
 */
async function deferUnimportable(input) {
  const info = input.source.classify(input.file.path, input.config);
  if (info === undefined) return undefined;
  const meta = { ...(input.entry?.meta ?? {}), ...info.meta };
  const consumed = { ...(input.entry ?? {}), offset: input.file.size, size: input.file.size, meta };
  if (typeof info.skip === 'string') {
    return { status: `skipped-${info.skip}`, entry: consumed };
  }
  const denied = /** @type {string[]} */ (input.config.denyCwdIncludes ?? []);
  if (denied.some((marker) => String(info.meta.cwd ?? '').includes(marker))) {
    return { status: 'skipped-denied', entry: consumed };
  }
  if (input.config.autoCreateWorkspaces === true) return undefined;
  const attachable = await input.target.canAttach(String(info.meta.cwd ?? ''));
  if (attachable !== false) return undefined;
  return {
    status: 'skipped-no-workspace',
    entry: { ...(input.entry ?? {}), size: input.file.size, meta, deferredAt: Date.now() },
  };
}

/**
 * Import the pending part of one source file into DSH.
 *
 * @param {object} input - import inputs.
 * @param {SourceAdapter} input.source - source adapter.
 * @param {TargetWriter} input.target - target writer.
 * @param {Record<string, unknown>} input.config - resolved import config.
 * @param {Record<string, any> | undefined} input.entry - recorded progress.
 * @param {SourceFile} input.file - discovered file.
 * @param {Record<string, string>} input.index - source title index.
 * @param {(message: string) => void} input.log - diagnostics sink.
 * @returns {Promise<Record<string, any>>} the new progress entry.
 */
export async function importOne(input) {
  const { source, target, config, file, index, log } = input;
  let entry = input.entry;
  let offset = Number(entry?.offset ?? 0);

  // A source that shrank was replaced or rotated. Re-appending it would
  // duplicate an already imported transcript, so the file is abandoned instead.
  if (entry !== undefined && offset > file.size) {
    log(`${source.id}: ${file.key} shrank (${offset} -> ${file.size}); not re-importing`);
    return { status: 'skipped-shrunk', entry: { ...entry, offset: file.size, size: file.size, shrunkAt: Date.now() } };
  }

  if (offset === 0) {
    const deferred = await deferUnimportable({ source, target, config, entry, file });
    if (deferred !== undefined) return deferred;
  }

  const read = readPendingTurns({
    source,
    path: file.path,
    offset,
    size: file.size,
    dialect: entry?.dialect,
    chunkBytes: Number(config.chunkBytes),
    maxChunkBytes: Number(config.maxChunkBytes),
  });
  if (read === undefined) return { status: 'pending', entry };

  const meta = { ...(entry?.meta ?? {}), ...(read.meta ?? {}) };
  const progress = { ...(entry ?? {}), offset: file.size, size: file.size, dialect: read.dialect, meta };
  if (entry === undefined && countUserItems(read.turns) < Number(config.minUserMessages ?? 1)) {
    return { status: 'skipped-empty', entry: progress };
  }

  const sessionKey = String(entry?.dshSessionId ?? target.sessionKey(file.key));
  let startSeq = 0;
  let creating = entry === undefined;
  if (!creating && entry !== undefined) {
    // A session the user deleted in DSH must not come back: resurrecting it from
    // the delta would produce a half session starting mid-conversation. An entry
    // that never created a session (a deferred project) still may.
    if (entry.removed === true && config.reimportDeleted !== true) {
      return { status: 'skipped-removed', entry };
    }
    const stored = await target.nextSeq(sessionKey, Number(entry.seq ?? 0));
    if (stored === undefined) {
      const importedBefore = Number(entry.seq ?? 0) > 0;
      if (importedBefore && config.reimportDeleted !== true) {
        return { status: 'skipped-removed', entry: { ...entry, removed: true } };
      }
      creating = true;
    } else {
      startSeq = stored;
    }
  }

  const built = target.buildEvents({
    turns: read.turns,
    startSeq,
    startTurn: creating ? 0 : Number(entry?.turn ?? 0),
    sessionKey,
    meta,
    toolOutputMaxChars: Number(config.toolOutputMaxChars),
    ...(creating ? { title: source.title({ turns: read.turns, meta, key: file.key, index }) } : {}),
  });

  const header = target.buildHeader({
    sessionKey,
    createdAt: Number(entry?.createdAt ?? file.mtimeMs ?? Date.now()),
    meta,
    agentPreset: String(config.agentPreset ?? ''),
  });
  await target.write(header, creating, built.events);

  return {
    status: creating ? 'created' : 'appended',
    entry: {
      dshSessionId: sessionKey,
      path: file.path,
      offset: offset + read.consumedBytes,
      size: file.size,
      seq: built.nextSeq,
      turn: built.nextTurn,
      dialect: read.dialect,
      createdAt: header.createdAt,
      meta,
    },
  };
}

/**
 * Fold the projections of imported sessions into the projection cache.
 *
 * The session list is deliberately zero-I/O for cold sessions: it serves titles
 * from the projection cache, and a session that was written but never folded
 * shows the workspace name until someone opens it. Folding each imported session
 * once makes its title appear in the sidebar immediately.
 *
 * @param {object} input - projection inputs.
 * @param {TargetWriter} input.target - target writer.
 * @param {Record<string, unknown>} input.config - resolved import config.
 * @param {Record<string, Record<string, any>>} input.sessions - import state namespace.
 * @param {(message: string) => void} input.log - diagnostics sink.
 * @returns {Promise<number>} number of sessions projected this pass.
 */
async function projectImported(input) {
  let projected = 0;
  const budget = Number(input.config.maxReprojectPerTick ?? 200);
  for (const entry of Object.values(input.sessions)) {
    if (projected >= budget) break;
    if (typeof entry.dshSessionId !== 'string' || entry.projected === true) continue;
    try {
      await input.target.project(entry.dshSessionId);
    } catch (error) {
      input.log(`${input.target.id}: projecting ${entry.dshSessionId} failed: ${String(error)}`);
    }
    entry.projected = true;
    projected += 1;
  }
  return projected;
}

/**
 * Run one import pass over every configured source root.
 *
 * @param {object} input - pass inputs.
 * @param {SourceAdapter} input.source - source adapter.
 * @param {TargetWriter} input.target - target writer.
 * @param {Record<string, unknown>} input.config - resolved import config.
 * @param {Record<string, unknown>} input.state - mutable state document.
 * @param {(message: string) => void} input.log - diagnostics sink.
 * @returns {Promise<Record<string, number>>} pass counters.
 */
export async function runImportPass(input) {
  const { source, target, config, state, log } = input;
  const sessions = importSessions(state);
  const files = /** @type {string[]} */ (config.roots ?? []).flatMap((root) => source.discover(root));
  const index = source.index();
  const now = Date.now();
  const deferRetryMs = Number(config.deferRetryMs ?? 6 * 3600 * 1000);
  const pending = files.filter((file) => {
    const entry = sessions[file.key];
    if (entry !== undefined) {
      if (entry.removed === true || entry.shrunkAt !== undefined) return false;
      // Only an exact match means "nothing new": a larger recorded offset is a
      // rewritten source, which importOne must see in order to abandon it.
      if (Number(entry.offset ?? 0) === file.size) return false;
      if (entry.deferredAt !== undefined && now - Number(entry.deferredAt) < deferRetryMs) return false;
    }
    if (Number(config.sinceMs ?? 0) > 0 && file.mtimeMs < Number(config.sinceMs)) return false;
    const maxBytes = Number(config.maxFileBytes ?? 0);
    return !(maxBytes > 0 && file.size > maxBytes);
  });
  pending.sort((left, right) =>
    config.newestFirst === false ? left.mtimeMs - right.mtimeMs : right.mtimeMs - left.mtimeMs
  );

  const counters = {
    discovered: files.length,
    pending: pending.length,
    examined: 0,
    created: 0,
    appended: 0,
    skipped: 0,
    failed: 0,
    projected: 0,
  };
  const maxFiles = Number(config.maxFilesPerTick ?? 200);
  const maxSessions = Number(config.maxSessionsPerTick ?? 25);
  let imported = 0;
  for (const file of pending) {
    if (counters.examined >= maxFiles || imported >= maxSessions) break;
    counters.examined += 1;
    try {
      const result = await importOne({ source, target, config, entry: sessions[file.key], file, index, log });
      if (result.status === 'created') {
        counters.created += 1;
        imported += 1;
      } else if (result.status === 'appended') {
        counters.appended += 1;
        imported += 1;
      } else {
        counters.skipped += 1;
      }
      if (result.entry !== undefined) sessions[file.key] = result.entry;
    } catch (error) {
      counters.failed += 1;
      log(`${source.id}: ${file.key} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  counters.projected = await projectImported({ target, config, sessions, log });
  return counters;
}
