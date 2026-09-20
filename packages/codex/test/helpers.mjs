/**
 * Shared fixtures for the Codex plugin tests: one synthetic two-turn rollout in
 * Codex's modern dialect, plus its session index.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CODEX_SESSION_ID = '019cd13f-cd2f-7172-91f9-ba9ef2373aff';

/**
 * Build one modern-dialect rollout record.
 * @param {Record<string, unknown>} payload - event payload.
 * @returns {string} one JSONL line.
 */
export function eventLine(payload) {
  return `${JSON.stringify({ timestamp: '2026-03-09T06:19:53.743Z', type: 'event_msg', payload })}\n`;
}

/**
 * Write a minimal two-turn, modern-dialect rollout plus its thread-name index.
 * @param {string} dir - temporary Codex home.
 * @returns {{sessionsDir: string, rolloutPath: string}} written paths.
 */
export function writeCodexHome(dir, sessionId = CODEX_SESSION_ID) {
  const sessionsDir = join(dir, 'sessions', '2026', '03', '09');
  mkdirSync(sessionsDir, { recursive: true });
  const rolloutPath = join(sessionsDir, `rollout-2026-03-09T14-19-05-${sessionId}.jsonl`);
  const meta = `${JSON.stringify({
    timestamp: '2026-03-09T06:19:05.397Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd: '/tmp/codex-dsh-portage-project', model_provider: 'openai' },
  })}\n`;
  const body = [
    `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex' } })}\n`,
    eventLine({
      type: 'item_completed',
      turn_id: 't1',
      item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'list the files' }] },
    }),
    eventLine({
      type: 'item_completed',
      turn_id: 't1',
      item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'Running ls.' }] },
    }),
    eventLine({
      type: 'item_completed',
      turn_id: 't1',
      item: {
        type: 'CommandExecution',
        id: 'c1',
        command: ['/bin/zsh', '-lc', 'ls'],
        aggregated_output: 'a.txt\nb.txt\n',
        exit_code: '0',
      },
    }),
    eventLine({ type: 'task_complete', turn_id: 't1' }),
    eventLine({
      type: 'item_completed',
      turn_id: 't2',
      item: { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: 'now count them' }] },
    }),
    eventLine({
      type: 'item_completed',
      turn_id: 't2',
      item: { type: 'AgentMessage', id: 'a2', content: [{ type: 'Text', text: 'There are two.' }] },
    }),
    eventLine({ type: 'task_complete', turn_id: 't2' }),
  ].join('');
  writeFileSync(rolloutPath, meta + body);
  writeFileSync(
    join(dir, 'session_index.jsonl'),
    `${JSON.stringify({ id: sessionId, thread_name: 'List the files', updated_at: '2026-03-09T06:20:00.000Z' })}\n`
  );
  return { sessionsDir: join(dir, 'sessions'), rolloutPath };
}

