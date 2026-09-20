/**
 * Public surface of the shared sync core.
 *
 * @module dsh-portage-core
 */

/**
 * @typedef {import('./ir.js').Item} Item
 * @typedef {import('./ir.js').ItemKind} ItemKind
 * @typedef {import('./ir.js').SourceMeta} SourceMeta
 * @typedef {import('./ir.js').SyncHost} SyncHost
 * @typedef {import('./ir.js').ToolPayload} ToolPayload
 * @typedef {import('./ir.js').Transcript} Transcript
 * @typedef {import('./ir.js').Turn} Turn
 * @typedef {import('./pipeline.js').ParsedChunk} ParsedChunk
 * @typedef {import('./pipeline.js').SourceAdapter} SourceAdapter
 * @typedef {import('./pipeline.js').SourceFile} SourceFile
 * @typedef {import('./pipeline.js').TargetWriter} TargetWriter
 */

export { IR_VERSION, countUserItems, createTranscript, firstUserText, isAbsolutePath, isItem } from './ir.js';
export { DEFAULT_CHUNK_BYTES, DEFAULT_MAX_CHUNK_BYTES, importOne, readPendingTurns, runImportPass } from './pipeline.js';
export { createScheduler } from './schedule.js';
export { registerSyncPlugin } from './runner.js';
export {
  defaultStatePath,
  emptyState,
  exportAnchors,
  importSessions,
  loadState,
  migrateLegacyState,
  normalizeState,
  saveState,
  STATE_VERSION,
} from './state.js';
export { createDshWriter, DshEventEmitter, emitTurn } from './dsh/write.js';
