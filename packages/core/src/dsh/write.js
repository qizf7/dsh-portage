/**
 * The DSH half of a sync plugin: build valid format-v3 session events from a
 * transcript, then persist them through DSH's own seams.
 *
 * Every event obeys the durable envelope contract (`type`, `seq`, `time`,
 * `data`), the surface-marker rule (`surfaceOp` on message-bearing events, and
 * never `sourceEventSeqs` on `assistant/message`), and the identified-message
 * rule enforced by `adoptSessionEvent`. Writes go through `sessionPersistence`,
 * so artifact layout, compression, sequence contiguity, write leases, and
 * future format migrations stay DSH's responsibility.
 *
 * @module dsh-portage-core/dsh/write
 */

import { isAbsolutePath } from '../ir.js';

/** Milliseconds to keep a monotonically non-decreasing event time. */
const TIME_STEP_MS = 1;

/**
 * Serialize one tool argument object the way DSH stores tool calls.
 * @param {unknown} args - neutral tool arguments.
 * @returns {string} a JSON string.
 */
function argumentsJson(args) {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return '{}';
  }
}

/**
 * Clamp one tool output to the configured character budget.
 * @param {string} text - raw tool output.
 * @param {number} maxChars - maximum retained characters.
 * @returns {string} the possibly truncated output.
 */
function truncateOutput(text, maxChars) {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]`;
}

/** Incremental DSH session event emitter over imported Codex turns. */
export class DshEventEmitter {
  /**
   * @param {object} options - emitter options.
   * @param {number} options.startSeq - first sequence number to assign.
   * @param {number} options.startTurn - last DSH turn number already imported.
   * @param {string} options.provider - provider recorded on assistant messages.
   * @param {string} options.model - model recorded on assistant messages.
   * @param {number} options.toolOutputMaxChars - per-result output budget.
   */
  constructor(options) {
    this.seq = options.startSeq;
    this.turn = options.startTurn;
    this.time = Date.now();
    this.provider = options.provider;
    this.model = options.model;
    this.toolOutputMaxChars = options.toolOutputMaxChars;
  }

  /** @returns {number} the next sequence number. */
  nextSeq() {
    const seq = this.seq;
    this.seq += 1;
    return seq;
  }

  /** @returns {number} the next event time. */
  nextTime() {
    this.time += TIME_STEP_MS;
    return this.time;
  }

  /**
   * Build one envelope.
   * @param {string} type - event type.
   * @param {Record<string, unknown>} data - event payload.
   * @param {Record<string, unknown>} [extra] - optional envelope members.
   * @returns {Record<string, unknown>} the event.
   */
  event(type, data, extra = {}) {
    return { type, seq: this.nextSeq(), time: this.nextTime(), data, ...extra };
  }

  /**
   * Build the `assistant/message` event for one pending content block list.
   * @param {number} turn - DSH turn number.
   * @param {number} step - DSH step number.
   * @param {Record<string, unknown>[]} content - assistant content blocks.
   * @param {string} messageId - stable message id.
   * @returns {Record<string, unknown>} the event.
   */
  assistantMessage(turn, step, content, messageId) {
    return this.event(
      'assistant/message',
      {
        turn,
        step,
        message: {
          role: 'assistant',
          id: messageId,
          content,
          source: { kind: 'model', provider: this.provider, model: this.model },
        },
        // Imported replies have no live stream; the settlement contract still
        // requires the member to be an array.
        stream: [],
      },
      { surfaceOp: 'append' }
    );
  }

  /**
   * Build the `tool/call` and `tool/result` pair for one neutral tool item.
   * @param {number} turn - DSH turn number.
   * @param {number} step - DSH step number.
   * @param {import('../ir.js').Item} item - neutral tool item.
   * @param {string} callId - stable call id.
   * @returns {Record<string, unknown>[]} the two events.
   */
  toolPair(turn, step, item, callId) {
    const call = this.event('tool/call', {
      turn,
      step,
      callId,
      name: String(item.tool?.name ?? 'tool'),
      arguments: argumentsJson(item.tool?.args),
    });
    const result = this.event(
      'tool/result',
      {
        turn,
        step,
        message: {
          role: 'user',
          id: `result-${callId}`,
          source: { kind: 'tool', callId },
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              content: [
                { type: 'text', text: truncateOutput(String(item.tool?.output ?? ''), this.toolOutputMaxChars) },
              ],
              isError: item.tool?.isError === true,
            },
          ],
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [call.seq] }
    );
    return [call, result];
  }

  /**
   * Build the `session/title` event.
   * @param {string} title - display title.
   * @param {number[]} messageSeqs - source message sequence numbers.
   * @returns {Record<string, unknown>} the event.
   */
  title(title, messageSeqs) {
    return this.event('session/title', {
      title,
      messageSeqs,
      source: { kind: 'fallback' },
    });
  }
}

/**
 * Split one Codex turn into DSH steps and emit every event for it.
 *
 * A step mirrors one model call: reasoning and assistant text accumulate into
 * one `assistant/message`, consecutive tool items attach to it as `tool-call`
 * blocks, and a new step starts when assistant output resumes after tools.
 *
 * @param {DshEventEmitter} emitter - emitter owning the sequence counter.
 * @param {import('../ir.js').Turn} turn - one complete turn.
 * @param {string} sessionKey - stable prefix for generated ids.
 * @returns {{events: Record<string, unknown>[], firstUserSeq: number|undefined}} the turn's events.
 */
export function emitTurn(emitter, turn, sessionKey) {
  const turnNumber = emitter.turn + 1;
  emitter.turn = turnNumber;
  const events = [];
  let step = 0;
  let stepOpen = false;
  let assistantSeen = false;
  let toolSeen = false;
  let content = [];
  let firstUserSeq;
  let messageCounter = 0;

  const flushAssistant = () => {
    if (content.length === 0) return;
    messageCounter += 1;
    events.push(
      emitter.assistantMessage(turnNumber, step, content, `${sessionKey}-a${turnNumber}-${messageCounter}`)
    );
    content = [];
    assistantSeen = true;
  };
  const openStep = () => {
    step += 1;
    stepOpen = true;
    assistantSeen = false;
    toolSeen = false;
    events.push(emitter.event('step/start', { turn: turnNumber, step }));
  };
  const closeStep = () => {
    flushAssistant();
    if (!stepOpen) return;
    events.push(emitter.event('step/end', { turn: turnNumber, step }));
    stepOpen = false;
  };

  events.push(emitter.event('turn/start', { turn: turnNumber }));

  for (let index = 0; index < turn.items.length; index += 1) {
    const item = turn.items[index];
    if (item.kind === 'user') {
      closeStep();
      openStep();
      const seq = emitter.seq;
      events.push(
        emitter.event(
          'user/message',
          {
            role: 'user',
            id: `${sessionKey}-u${turnNumber}-${index}`,
            content: [{ type: 'text', text: String(item.text ?? '') }],
            source: { kind: 'user' },
          },
          { surfaceOp: 'append' }
        )
      );
      if (firstUserSeq === undefined) firstUserSeq = seq;
      continue;
    }
    if (item.kind === 'tool') {
      if (!stepOpen) openStep();
      const callId = String(item.id ?? '') || `${sessionKey}-c${turnNumber}-${index}`;
      if (content.length > 0 || !assistantSeen) {
        content.push({
          type: 'tool-call',
          id: callId,
          name: String(item.tool?.name ?? 'tool'),
          arguments: argumentsJson(item.tool?.args),
        });
        flushAssistant();
      }
      events.push(...emitter.toolPair(turnNumber, step, item, callId));
      toolSeen = true;
      continue;
    }
    const isReasoning = item.kind === 'reasoning' || item.kind === 'plan';
    if ((assistantSeen || toolSeen) && content.length === 0) closeStep();
    if (!stepOpen) openStep();
    content.push({
      type: isReasoning ? 'reasoning' : 'text',
      text: String(item.text ?? ''),
    });
  }

  closeStep();
  events.push(emitter.event('turn/end', { turn: turnNumber, reason: { kind: 'completed' } }));
  return { events, firstUserSeq };
}

// ---------------------------------------------------------------------------
// DSH target writer
// ---------------------------------------------------------------------------

/**
 * Build the event batch for one run of complete turns.
 * @param {object} input - batch inputs.
 * @param {import('../ir.js').Turn[]} input.turns - complete turns.
 * @param {number} input.startSeq - next free sequence number.
 * @param {number} input.startTurn - last imported turn number.
 * @param {string} input.sessionKey - DSH session id used for stable message ids.
 * @param {import('../ir.js').SourceMeta} input.meta - provider/model metadata.
 * @param {number} input.toolOutputMaxChars - tool output budget.
 * @param {string} [input.title] - title event to append (create only).
 * @param {string} input.defaultProvider - provider used when the source omits one.
 * @param {string} input.defaultModel - model used when the source omits one.
 * @returns {{events: Record<string, unknown>[], nextSeq: number, nextTurn: number, firstUserSeq?: number}} the batch.
 */
function buildEventsFor(input) {
  const emitter = new DshEventEmitter({
    startSeq: input.startSeq,
    startTurn: input.startTurn,
    provider: String(input.meta.provider ?? input.defaultProvider),
    model: String(input.meta.model ?? input.defaultModel),
    toolOutputMaxChars: input.toolOutputMaxChars,
  });
  const events = [];
  let firstUserSeq;
  for (const turn of input.turns) {
    const emitted = emitTurn(emitter, turn, input.sessionKey);
    events.push(...emitted.events);
    if (firstUserSeq === undefined) firstUserSeq = emitted.firstUserSeq;
  }
  if (typeof input.title === 'string' && input.title.length > 0) {
    events.push(emitter.title(input.title, firstUserSeq === undefined ? [] : [firstUserSeq]));
  }
  return { events, nextSeq: emitter.seq, nextTurn: emitter.turn, firstUserSeq };
}

/**
 * Build the DSH session header for one source session.
 * @param {{sessionKey: string, createdAt: number, meta: import('../ir.js').SourceMeta, agentPreset: string}} input - header inputs.
 * @returns {Record<string, unknown>} the header.
 */
function buildHeader(input) {
  const header = {
    version: 3,
    id: input.sessionKey,
    createdAt: Math.floor(Number(input.createdAt)),
    isSeeded: false,
    delegationDepth: 0,
  };
  const cwd = String(input.meta.cwd ?? '');
  if (isAbsolutePath(cwd)) header.cwd = cwd;
  if (input.agentPreset.length > 0) header.agentPreset = input.agentPreset;
  return header;
}

/**
 * Attach one imported session to the workspace owning its canonical cwd.
 * @param {import('../ir.js').SyncHost} ctx - plugin context.
 * @param {Record<string, unknown>} options - writer options.
 * @param {string} sessionKey - imported DSH session id.
 * @param {string} cwd - canonical project directory.
 * @returns {Promise<void>} resolution after the attach attempt.
 */
async function attachWorkspace(ctx, options, sessionKey, cwd) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined || cwd.length === 0) return;
  const log = /** @type {(message: string) => void} */ (options.log);
  try {
    const existing = await registry.resolveByPath(cwd);
    const workspace =
      existing ?? (options.autoCreateWorkspaces === true ? await registry.create(cwd) : undefined);
    if (workspace === undefined) return;
    await workspace.attachSession(sessionKey);
  } catch (error) {
    log(`dsh: workspace attach failed for ${sessionKey} (${cwd}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Create the DSH target writer over one plugin context.
 *
 * @param {import('../ir.js').SyncHost} ctx - plugin context.
 * @param {object} options - writer options.
 * @param {string} options.tool - external tool name used in session ids.
 * @param {boolean} options.autoCreateWorkspaces - whether missing workspaces may be created.
 * @param {string} options.defaultProvider - provider fallback for assistant messages.
 * @param {string} options.defaultModel - model fallback for assistant messages.
 * @param {(message: string) => void} options.log - diagnostics sink.
 * @returns {import('../pipeline.js').TargetWriter} the writer.
 */
export function createDshWriter(ctx, options) {
  const persistence = ctx.sessionPersistence;
  const log = options.log;
  return {
    id: 'dsh',
    sessionKey: (sourceKey) => `session-${options.tool}-${sourceKey}`,
    buildEvents: (input) =>
      buildEventsFor({
        ...input,
        defaultProvider: options.defaultProvider,
        defaultModel: options.defaultModel,
      }),
    buildHeader: (input) => buildHeader(input),
    nextSeq: async (sessionKey, fallback) => {
      let handle;
      try {
        handle = await persistence.open(sessionKey, 'read');
      } catch (error) {
        if (/** @type {{name?: string}} */ (error)?.name === 'SessionPersistenceNotFoundError') return undefined;
        throw error;
      }
      try {
        const { events } = await handle.read();
        if (events.length !== fallback) {
          log(`dsh: ${sessionKey} has ${events.length} stored events but state expected ${fallback}; continuing from stored length`);
        }
        return events.length;
      } finally {
        await handle.close();
      }
    },
    write: async (header, create, events) => {
      const handle = create ? await persistence.create(header) : await persistence.open(header.id, 'write');
      try {
        if (events.length > 0) await handle.append(events);
        await handle.flush();
      } finally {
        await handle.close();
      }
      if (create) await attachWorkspace(ctx, options, String(header.id), String(header.cwd ?? ''));
    },
    canAttach: async (cwd) => {
      const registry = ctx.get('workspaceRegistry');
      if (registry === undefined || !isAbsolutePath(String(cwd))) return undefined;
      try {
        return (await registry.resolveByPath(cwd)) !== undefined;
      } catch {
        return false;
      }
    },
    project: async (sessionKey) => {
      const cache = ctx.get('sessionProjectionCache');
      if (cache === undefined) return false;
      const snapshot = await persistence.stat(sessionKey);
      if (snapshot === undefined) return false;
      const handle = await persistence.open(sessionKey, 'read');
      try {
        const { events } = await handle.read();
        cache.coldSnapshot(snapshot.header, handle.inheritedEventCount, events);
        return true;
      } finally {
        await handle.close();
      }
    },
  };
}
