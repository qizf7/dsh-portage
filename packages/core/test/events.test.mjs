/**
 * Event emission contract: the sequence a provider accepts.
 *
 * A tool result is only legal directly after an assistant message that
 * announced its call, which is exactly what a resumed session replays — so
 * these tests pin the invariant that made imported Codex sessions fail with
 * "Messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DshEventEmitter, emitTurn } from 'dsh-portage-core';

/**
 * Build one tool item.
 * @param {string} id - call id.
 * @param {string} output - tool output.
 * @returns {object} the item.
 */
function tool(id, output) {
  return { kind: 'tool', id, tool: { name: 'bash', args: { command: id }, output, isError: false } };
}

/**
 * Emit one turn.
 * @param {object[]} items - turn items.
 * @returns {object[]} the emitted events.
 */
function emit(items) {
  const emitter = new DshEventEmitter({
    startSeq: 0,
    startTurn: 0,
    provider: 'openai',
    model: 'gpt-5-codex',
    toolOutputMaxChars: 100,
  });
  return emitTurn(emitter, { id: 't1', settled: true, items }, 'session-codex-x').events;
}

/**
 * Collect every call id announced by an assistant message.
 * @param {object[]} events - emitted events.
 * @returns {Set<string>} announced call ids.
 */
function announcedCalls(events) {
  const ids = new Set();
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    for (const block of event.data.message.content) {
      if (block.type === 'tool-call') ids.add(block.id);
    }
  }
  return ids;
}

describe('DSH event emission', () => {
  it('announces every call of a consecutive run before its result', () => {
    const events = emit([
      { kind: 'reasoning', id: 'r1', text: 'thinking' },
      { kind: 'assistant', id: 'a1', text: 'working' },
      tool('c1', 'one'),
      tool('c2', 'two'),
      tool('c3', 'three'),
    ]);
    const announced = announcedCalls(events);
    const results = events.filter((event) => event.type === 'tool/result');
    assert.equal(results.length, 3);
    for (const result of results) {
      const callId = result.data.message.source.callId;
      assert.ok(announced.has(callId), `${callId} was never announced by an assistant message`);
    }
    assert.deepEqual([...announced].sort(), ['c1', 'c2', 'c3']);
  });

  it('keeps the item that follows a run of tool calls', () => {
    const events = emit([
      { kind: 'user', id: 'u1', text: 'go' },
      tool('c1', 'out'),
      { kind: 'assistant', id: 'a1', text: 'all done' },
    ]);
    const texts = events
      .filter((event) => event.type === 'assistant/message')
      .flatMap((event) => event.data.message.content.filter((block) => block.type === 'text').map((block) => block.text));
    assert.deepEqual(texts, ['all done']);
  });

  it('announces a call when a turn opens with a tool', () => {
    const events = emit([tool('c1', 'only')]);
    const assistant = events.find((event) => event.type === 'assistant/message');
    assert.equal(assistant.data.message.content[0].type, 'tool-call');
    assert.equal(assistant.data.message.content[0].id, 'c1');
    assert.equal(events.find((event) => event.type === 'tool/result').data.message.source.callId, 'c1');
  });

  it('opens a new step when assistant output resumes after tools', () => {
    const events = emit([tool('c1', 'out'), { kind: 'assistant', id: 'a1', text: 'next' }]);
    const steps = events.filter((event) => event.type === 'step/start').map((event) => event.data.step);
    assert.deepEqual(steps, [1, 2]);
  });
});
