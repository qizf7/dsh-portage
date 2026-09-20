/**
 * Codex CLI rollout parsing: turn the append-only rollout JSONL into the
 * pipeline's neutral transcript model.
 *
 * Two dialects exist in the wild: modern rollouts carry a normalized
 * `event_msg/item_completed` stream, older ones only `response_item` records.
 * A file is read in exactly one dialect so duplicated rows never import twice.
 * Only *complete* turns are returned; a turn still being written stays outside
 * the consumed byte range so the next pass re-reads it.
 *
 * @module dsh-portage-codex/codex/read
 */

/** Item kinds the transcript model admits. */
const ITEM_KINDS = new Set(['user', 'reasoning', 'assistant', 'tool', 'plan']);

/** Dialect marker found in modern rollout bytes. */
const ITEM_DIALECT_MARKER = '"item_completed"';

/**
 * Split a buffer into complete newline-terminated lines with byte offsets.
 * @param {Buffer} buffer - raw rollout bytes from the read offset.
 * @returns {{text: string, start: number, end: number}[]} complete lines.
 */
export function completeLines(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    const raw = buffer.subarray(start, index);
    const lineStart = start;
    start = index + 1;
    if (raw.length > 0) lines.push({ text: raw.toString('utf8'), start: lineStart, end: start });
  }
  return lines;
}

/**
 * Read the JSON object on one rollout line.
 * @param {string} text - one raw line.
 * @returns {Record<string, any> | undefined} the parsed record, or undefined.
 */
function parseRecord(text) {
  if (!text.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Join one Codex content-block array into a single string.
 * @param {unknown} content - Codex content blocks.
 * @returns {string} the joined text.
 */
export function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * Marker Codex appends to an attachment/ambient preamble; the real request
 * always follows it.
 */
const REQUEST_MARKER = '## My request:';

/**
 * Runtime-injected user content that carries no user request at all. Codex
 * delivers AGENTS.md, permissions, plugin and skill notices as `role: user`
 * messages, so they must never surface as user turns.
 */
const INJECTED_PREFIXES = [
  '# AGENTS.md',
  '<environment_context>',
  '<permissions instructions>',
  '<recommended_plugins>',
  '<turn_aborted>',
  '<skill>',
  '<codex_internal_context',
  '<heartbeat>',
];

/** Whether text is nothing but `<image …>` framing. */
const IMAGE_FRAMING = /^(?:<\/?image[^>]*>\s*)+$/;

/**
 * Reduce one user-authored message to the text the user actually wrote.
 *
 * Attachment and ambient-UI preambles (`# Files mentioned by the user:`,
 * `<in-app-browser-context>`) embed the request under `## My request:`, so the
 * tail is kept rather than the whole message being discarded.
 *
 * @param {string} text - joined content blocks.
 * @returns {string} the user-authored text, or an empty string when injected.
 */
export function cleanUserText(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const marker = trimmed.lastIndexOf(REQUEST_MARKER);
  if (marker !== -1) return trimmed.slice(marker + REQUEST_MARKER.length).trim();
  if (IMAGE_FRAMING.test(trimmed)) return '';
  if (INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return '';
  return trimmed;
}

/**
 * Normalize a `CommandExecution` item into a tool item.
 * @param {Record<string, any>} item - Codex item payload.
 * @returns {Record<string, any>} neutral tool item.
 */
function commandItem(item) {
  const command = Array.isArray(item.command) ? item.command : [];
  const exitCode = typeof item.exit_code === 'string' ? Number(item.exit_code) : item.exit_code;
  const output = String(item.aggregated_output ?? item.stdout ?? '');
  return {
    kind: 'tool',
    id: String(item.id ?? ''),
    tool: {
      name: 'bash',
      args: { command: command.join(' ') },
      output,
      isError: typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0,
    },
  };
}

/**
 * Normalize an `McpToolCall` item into a tool item.
 * @param {Record<string, any>} item - Codex item payload.
 * @returns {Record<string, any>} neutral tool item.
 */
function mcpItem(item) {
  const result = /** @type {Record<string, any>} */ (
    item.result && typeof item.result === 'object' ? item.result : {}
  );
  return {
    kind: 'tool',
    id: String(item.id ?? ''),
    tool: {
      name: `${String(item.server ?? 'mcp')}.${String(item.tool ?? 'call')}`,
      args: item.arguments ?? {},
      output: contentText(result.content),
      isError: item.status === 'failed' || item.status === 'error',
    },
  };
}

/**
 * Normalize a `FileChange` item into a tool item carrying its unified diff.
 * @param {Record<string, any>} item - Codex item payload.
 * @returns {Record<string, any>} neutral tool item.
 */
function fileChangeItem(item) {
  const changes = /** @type {Record<string, Record<string, any>>} */ (
    item.changes && typeof item.changes === 'object' ? item.changes : {}
  );
  const paths = Object.keys(changes);
  const output = paths
    .map((path) => {
      const change = changes[path] ?? {};
      return `--- ${change.type ?? 'update'} ${path}\n${change.unified_diff ?? ''}`;
    })
    .join('\n');
  return {
    kind: 'tool',
    id: String(item.id ?? ''),
    tool: {
      name: 'apply_patch',
      args: { paths },
      output,
      isError: false,
    },
  };
}

/**
 * Normalize one `item_completed` item payload.
 * @param {Record<string, any>} item - Codex item payload.
 * @returns {Record<string, any> | undefined} neutral item, or undefined when unusable.
 */
export function normalizeItem(item) {
  switch (item.type) {
    case 'UserMessage': {
      const text = cleanUserText(contentText(item.content));
      return text.length === 0 ? undefined : { kind: 'user', id: String(item.id ?? ''), text };
    }
    case 'AgentMessage':
      return { kind: 'assistant', id: String(item.id ?? ''), text: contentText(item.content) };
    case 'Reasoning': {
      const summary = /** @type {any[]} */ (Array.isArray(item.summary_text) ? item.summary_text : []);
      return { kind: 'reasoning', id: String(item.id ?? ''), text: summary.join('\n') };
    }
    case 'Plan':
      return { kind: 'plan', id: String(item.id ?? ''), text: String(item.text ?? '') };
    case 'ImageView': {
      const path = String(item.path ?? '').replace(/^file:\/\//, '');
      return path.length === 0 ? undefined : { kind: 'user', id: String(item.id ?? ''), text: `[image] ${path}` };
    }
    case 'CommandExecution':
      return commandItem(item);
    case 'McpToolCall':
      return mcpItem(item);
    case 'FileChange':
      return fileChangeItem(item);
    default:
      return undefined;
  }
}

/**
 * Normalize a legacy `response_item` record.
 * @param {Record<string, any>} payload - `response_item` payload.
 * @returns {Record<string, any> | undefined} neutral item, or undefined.
 */
function normalizeResponseItem(payload) {
  if (payload.type === 'message') {
    const text = cleanUserText(contentText(payload.content));
    if (text.length === 0) return undefined;
    if (payload.role === 'assistant') return { kind: 'assistant', id: '', text };
    if (payload.role === 'user') return { kind: 'user', id: '', text };
    return undefined;
  }
  if (payload.type === 'reasoning') {
    const summary = /** @type {any[]} */ (Array.isArray(payload.summary) ? payload.summary : []);
    const text = summary
      .map((entry) => (entry && typeof entry.text === 'string' ? entry.text : ''))
      .filter((entry) => entry.length > 0)
      .join('\n');
    return text.length === 0 ? undefined : { kind: 'reasoning', id: '', text };
  }
  return undefined;
}

/**
 * Detect which rollout dialect a byte stream uses.
 * @param {Buffer} buffer - bytes read from offset zero.
 * @returns {'items' | 'legacy'} the dialect.
 */
export function detectDialect(buffer) {
  return buffer.includes(ITEM_DIALECT_MARKER) ? 'items' : 'legacy';
}

/**
 * Whether a Codex `session_meta.source` marks an internal subagent rollout.
 * Codex encodes both guardian/approval helpers and spawned subagent threads as
 * `{ subagent: … }`; neither is a user-facing session.
 * @param {unknown} source - the `session_meta` source value.
 * @returns {boolean} whether the rollout belongs to an internal subagent.
 */
export function isSubagentSource(source) {
  return typeof source === 'object' && source !== null && !Array.isArray(source) && 'subagent' in source;
}

/**
 * Read only the `session_meta` record of a rollout, which is always its first
 * line, so a file can be classified without parsing its whole body.
 * @param {Buffer} buffer - bytes read from offset zero.
 * @returns {Record<string, any> | undefined} metadata, or undefined when absent.
 */
export function parseSessionMeta(buffer) {
  for (const line of completeLines(buffer)) {
    const record = parseRecord(line.text);
    if (record === undefined) continue;
    if (record.type !== 'session_meta') return undefined;
    const payload = /** @type {Record<string, any>} */ (
      record.payload && typeof record.payload === 'object' ? record.payload : {}
    );
    return {
      sessionId: String(payload.id ?? payload.session_id ?? ''),
      cwd: String(payload.cwd ?? ''),
      provider: String(payload.model_provider ?? 'openai'),
      source: payload.source,
      timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
    };
  }
  return undefined;
}

/** Accumulates turns while one rollout chunk is scanned. */
class TranscriptBuilder {
  constructor() {
    /** @type {Record<string, any>[]} */
    this.turns = [];
    /** @type {Record<string, any> | undefined} */
    this.meta = undefined;
    /** @type {any} */
    this.openTurnRef = undefined;
    this.consumed = 0;
  }

  /** @returns {Record<string, any> | undefined} the open turn. */
  get open() {
    return this.turns[this.turns.length - 1];
  }

  /**
   * Open a new turn.
   * @param {string} id - Codex turn id.
   * @returns {Record<string, any>} the opened turn.
   */
  openTurn(id) {
    /** @type {Record<string, any>} */
    const turn = { id, items: [], complete: false };
    this.turns.push(turn);
    return turn;
  }

  /**
   * Close the open turn at one byte offset, which becomes the resume point.
   * @param {number} offset - byte offset that the next pass resumes from.
   */
  closeTurn(offset) {
    if (this.open !== undefined) this.open.complete = true;
    this.consumed = Math.max(this.consumed, offset);
  }

  /**
   * Append one item to the open turn, opening one when absent.
   * @param {Record<string, any>} item - neutral item.
   * @param {string} turnId - Codex turn id.
   */
  push(item, turnId) {
    if (this.open === undefined || this.open.complete) this.openTurn(turnId);
    this.open.items.push(item);
  }
}

/**
 * Apply one modern `event_msg` record.
 *
 * Turn boundaries follow user messages, not Codex's `turn_id`: Codex splits a
 * single user request into many internal turns when it resumes or compacts, and
 * mirroring that would flood DSH with empty turns. A turn is only finalized on
 * the next user message, so the resume offset never skips a record.
 *
 * @param {TranscriptBuilder} builder - accumulator.
 * @param {Record<string, any>} payload - event payload.
 * @param {{start: number, end: number}} line - record byte range.
 * @returns {void}
 */
function applyEventMessage(builder, payload, line) {
  if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
    if (builder.open !== undefined) builder.open.settled = true;
    return;
  }
  if (payload.type !== 'item_completed') return;
  const turnId = String(payload.turn_id ?? '');
  const raw = /** @type {Record<string, any>} */ (
      payload.item && typeof payload.item === 'object' ? payload.item : {}
    );
  const item = normalizeItem(raw);
  if (item === undefined || !ITEM_KINDS.has(item.kind)) return;
  if (item.kind === 'user' && builder.open !== undefined && builder.open.items.length > 0) {
    builder.closeTurn(line.start);
  }
  builder.push(item, turnId);
}

/**
 * Apply one legacy `response_item` record.
 * @param {TranscriptBuilder} builder - accumulator.
 * @param {Record<string, any>} payload - response item payload.
 * @param {{start: number, end: number}} line - record byte range.
 * @returns {void}
 */
function applyResponseItem(builder, payload, line) {
  const item = normalizeResponseItem(payload);
  if (item === undefined) return;
  if (item.kind === 'user' && builder.open !== undefined && builder.open.items.length > 0) {
    builder.closeTurn(line.start);
  }
  builder.push(item, '');
}

/**
 * Parse rollout bytes into complete turns.
 *
 * @param {Buffer} buffer - bytes from `fromByte` to end of file.
 * @param {object} options - parse options.
 * @param {'items' | 'legacy'} options.dialect - rollout dialect in force.
 * @returns {{meta?: Record<string, any>, turns: Record<string, any>[], consumedBytes: number}}
 *   complete turns and the byte offset the next pass resumes from.
 */
export function parseRollout(buffer, options) {
  const builder = new TranscriptBuilder();
  const lines = completeLines(buffer);

  for (const line of lines) {
    const record = parseRecord(line.text);
    if (record === undefined) continue;
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};

    if (record.type === 'session_meta') {
      builder.meta = {
        sessionId: String(payload.id ?? payload.session_id ?? ''),
        cwd: String(payload.cwd ?? ''),
        provider: String(payload.model_provider ?? 'openai'),
        source: payload.source,
      };
    } else if (record.type === 'turn_context') {
      if (builder.meta !== undefined && typeof payload.model === 'string') {
        builder.meta.model = payload.model;
      }
    } else if (record.type === 'event_msg' && options.dialect === 'items') {
      applyEventMessage(builder, payload, line);
    } else if (record.type === 'response_item' && options.dialect === 'legacy') {
      applyResponseItem(builder, payload, line);
    }
  }

  if (options.dialect === 'legacy') {
    for (const turn of builder.turns) turn.complete = true;
    if (lines.length > 0) builder.consumed = lines[lines.length - 1].end;
  } else if (builder.open !== undefined && builder.open.settled === true) {
    for (const turn of builder.turns) {
      if (turn.settled === true && turn.items.length > 0) turn.complete = true;
    }
    if (lines.length > 0) builder.consumed = lines[lines.length - 1].end;
  }

  return {
    meta: builder.meta,
    turns: builder.turns.filter((turn) => turn.complete && turn.items.length > 0),
    consumedBytes: builder.consumed,
  };
}
