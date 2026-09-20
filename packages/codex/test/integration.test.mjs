/**
 * Integration tests: import real rollout files through the pipeline into a real
 * JSONL persistence backend, then read the result back through the same strict
 * path DSH uses at startup.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { Session } from '@deepseek-ai/dsh-session';

import { createDshWriter, emptyState, importSessions, readPendingTurns, runImportPass } from 'dsh-portage-core';
import { createCodexSource } from '../src/codex/adapter.js';
import { CODEX_SESSION_ID, eventLine, writeCodexHome } from './helpers.mjs';


/**
 * Build a DSH target over one booted persistence service.
 * @param {object} persistence - session persistence service.
 * @param {Record<string, unknown>} overrides - per-test overrides.
 * @returns {object} the target writer.
 */
function createTestTarget(persistence, overrides = {}) {
  const projected = [];
  const target = createDshWriter(
    { sessionPersistence: persistence, get: () => undefined },
    {
      tool: 'codex',
      autoCreateWorkspaces: false,
      defaultProvider: 'openai',
      defaultModel: 'gpt-5-codex',
      log: () => {},
    }
  );
  const nextSeq = target.nextSeq.bind(target);
  target.nextSeq = async (sessionId, fallback) => {
    const stored = await nextSeq(sessionId, fallback);
    if (stored !== undefined) assert.equal(stored, fallback);
    return stored;
  };
  target.project = async (sessionId) => {
    projected.push(sessionId);
    return true;
  };
  return Object.assign(target, { projected }, overrides);
}

/**
 * Run one import pass the way the plugin runner does.
 * @param {object} target - target writer.
 * @param {Record<string, unknown>} config - resolved import config.
 * @param {Record<string, unknown>} state - mutable state document.
 * @param {(message: string) => void} log - diagnostics sink.
 * @returns {Promise<Record<string, number>>} pass counters.
 */
async function syncOnce(target, config, state, log) {
  return runImportPass({ source: createCodexSource(config), target, config, state, log });
}

/** Import-state namespace, kept short for the ported assertions. */
const sessionsOf = (state) => importSessions(state);

/**
 * Build the resolved import config used by the tests.
 * @param {string} home - temporary Codex home.
 * @returns {Record<string, unknown>} config.
 */
function testConfig(home) {
  return {
    roots: [join(home, 'sessions')],
    codexHome: home,
    newestFirst: true,
    autoCreateWorkspaces: false,
    denyCwdIncludes: ['/.codex/worktrees/'],
    maxSessionsPerTick: 10,
    maxFilesPerTick: 200,
    deferRetryMs: 6 * 3600 * 1000,
    maxReprojectPerTick: 200,
    reimportDeleted: false,
    maxFileBytes: 0,
    minUserMessages: 1,
    toolOutputMaxChars: 8000,
    chunkBytes: 64 * 1024,
    maxChunkBytes: 512 * 1024,
    sinceMs: 0,
    agentPreset: 'standard',
  };
}

describe('sync pass', () => {
  let ctx;
  let root;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'codex-dsh-root-'));
    ctx = new Context();
    ctx.plugin(JsonlPersistence, { root });
    await ctx.start?.();
  });

  after(async () => {
    await ctx.stop?.();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a DSH session that the strict render path accepts, then appends new turns', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-sync-'));
    try {
      const { sessionsDir, rolloutPath } = writeCodexHome(home);
      const config = testConfig(home);
      const target = createTestTarget(ctx.sessionPersistence);
      const state = emptyState();

      const first = await syncOnce(target, config, state, () => {});
      assert.equal(first.created, 1);
      assert.equal(first.failed, 0);

      const sessionId = `session-codex-${CODEX_SESSION_ID}`;
      const read = await ctx.sessionPersistence.open(sessionId, 'read');
      const stored = await read.read();
      await read.close();
      assert.deepEqual(
        stored.events.map((event) => event.seq),
        stored.events.map((_, index) => index)
      );
      assert.equal(stored.events[0].type, 'turn/start');
      assert.equal(stored.events.at(-1).type, 'session/title');
      assert.ok(stored.events.some((event) => event.type === 'tool/call'));
      assert.ok(stored.events.some((event) => event.type === 'tool/result'));

      const snapshot = await ctx.sessionPersistence.stat(sessionId);
      const session = Session.fromRestore(sessionId, stored.events, snapshot.header, read.inheritedEventCount, stored.eventState);
      const roles = session.deriveMessages().map((message) => message.role);
      assert.deepEqual(roles, ['user', 'assistant', 'user', 'user', 'assistant']);

      const second = await syncOnce(target, config, state, () => {});
      assert.equal(second.pending, 0);
      assert.equal(second.created + second.appended, 0);

      appendFileSync(
        rolloutPath,
        eventLine({
          type: 'item_completed',
          turn_id: 't3',
          item: { type: 'UserMessage', id: 'u3', content: [{ type: 'text', text: 'and again' }] },
        }) +
          eventLine({
            type: 'item_completed',
            turn_id: 't3',
            item: { type: 'AgentMessage', id: 'a3', content: [{ type: 'Text', text: 'Sure.' }] },
          }) +
          eventLine({ type: 'task_complete', turn_id: 't3' })
      );

      const third = await syncOnce(target, config, state, () => {});
      assert.equal(third.appended, 1);
      const after = await ctx.sessionPersistence.open(sessionId, 'read');
      const grown = await after.read();
      await after.close();
      assert.ok(grown.events.length > stored.events.length);
      assert.deepEqual(
        grown.events.map((event) => event.seq),
        grown.events.map((_, index) => index)
      );
      assert.equal(grown.events.at(-1).type, 'turn/end');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips sessions whose cwd is denied and ones with no user message', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-skip-'));
    try {
      const sessionsDir = join(home, 'sessions', '2026', '03', '10');
      mkdirSync(sessionsDir, { recursive: true });
      const deniedId = 'aaaaaaaa-0000-0000-0000-000000000001';
      const meta = JSON.stringify({
        type: 'session_meta',
        payload: { id: deniedId, cwd: '/Users/x/.codex/worktrees/1/MemBox' },
      });
      const user = eventLine({
        type: 'item_completed',
        turn_id: 't1',
        item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }] },
      });
      writeFileSync(
        join(sessionsDir, `rollout-2026-03-10T10-00-00-${deniedId}.jsonl`),
        `${meta}\n${user}${eventLine({ type: 'task_complete', turn_id: 't1' })}`
      );

      const config = testConfig(home);
      const state = emptyState();
      const counters = await syncOnce(createTestTarget(ctx.sessionPersistence), config, state, () => {});
      assert.equal(counters.created + counters.appended, 0);
      assert.equal(counters.skipped, 1);
      await assert.rejects(() => ctx.sessionPersistence.open(`session-codex-${deniedId}`, 'read'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips internal subagent rollouts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-subagent-'));
    try {
      const sessionsDir = join(home, 'sessions', '2026', '03', '11');
      mkdirSync(sessionsDir, { recursive: true });
      const subagentId = 'bbbbbbbb-0000-0000-0000-000000000002';
      const meta = JSON.stringify({
        type: 'session_meta',
        payload: { id: subagentId, cwd: '/tmp/codex-dsh-portage-project', source: { subagent: { other: 'guardian' } } },
      });
      writeFileSync(
        join(sessionsDir, `rollout-2026-03-11T10-00-00-${subagentId}.jsonl`),
        `${meta}\n${eventLine({
          type: 'item_completed',
          turn_id: 't1',
          item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'guardian work' }] },
        })}${eventLine({ type: 'task_complete', turn_id: 't1' })}`
      );

      const { isSubagentSource } = await import('../src/codex/read.js');
      assert.equal(isSubagentSource({ subagent: { other: 'guardian' } }), true);
      assert.equal(isSubagentSource('cli'), false);

      const config = testConfig(home);
      const state = emptyState();
      const counters = await syncOnce(createTestTarget(ctx.sessionPersistence), config, state, () => {});
      assert.equal(counters.created, 0);
      assert.equal(counters.skipped, 1);
      await assert.rejects(() => ctx.sessionPersistence.open(`session-codex-${subagentId}`, 'read'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('defers sessions whose cwd has no workspace and retries after the deferral window', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-defer-'));
    const deferId = 'cccccccc-0000-0000-0000-000000000003';
    try {
      const { sessionsDir } = writeCodexHome(home, deferId);
      const config = testConfig(home);
      config.autoCreateWorkspaces = false;
      const state = emptyState();
      const blocked = await syncOnce(
        createTestTarget(ctx.sessionPersistence, { canAttach: async () => false }),
        config,
        state,
        () => {}
      );
      assert.equal(blocked.created, 0);
      assert.equal(blocked.skipped, 1);
      assert.equal(typeof sessionsOf(state)[deferId].deferredAt, 'number');

      const again = await syncOnce(
        createTestTarget(ctx.sessionPersistence, { canAttach: async () => true }),
        config,
        state,
        () => {}
      );
      assert.equal(again.examined, 0, 'deferred entries are not re-examined inside the window');

      sessionsOf(state)[deferId].deferredAt = Date.now() - 7 * 3600 * 1000;
      const retried = await syncOnce(
        createTestTarget(ctx.sessionPersistence, { canAttach: async () => true }),
        config,
        state,
        () => {}
      );
      assert.equal(retried.created, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not resurrect a session the user deleted in DSH', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-deleted-'));
    const deletedId = 'dddddddd-0000-0000-0000-000000000004';
    try {
      const { sessionsDir, rolloutPath } = writeCodexHome(home, deletedId);
      const config = testConfig(home);
      const state = emptyState();
      const first = await syncOnce(createTestTarget(ctx.sessionPersistence), config, state, () => {});
      assert.equal(first.created, 1);

      appendFileSync(
        rolloutPath,
        eventLine({
          type: 'item_completed',
          turn_id: 't3',
          item: { type: 'UserMessage', id: 'u3', content: [{ type: 'text', text: 'and again' }] },
        }) + eventLine({ type: 'task_complete', turn_id: 't3' })
      );

      const missing = await syncOnce(
        createTestTarget(ctx.sessionPersistence, { nextSeq: async () => undefined, project: async () => true }),
        config,
        state,
        () => {}
      );
      assert.equal(missing.created + missing.appended, 0);
      assert.equal(missing.skipped, 1);
      assert.equal(sessionsOf(state)[deletedId].removed, true);

      const after = await syncOnce(createTestTarget(ctx.sessionPersistence), config, state, () => {});
      assert.equal(after.examined, 0, 'a removed session is no longer examined');

      config.reimportDeleted = true;
      delete sessionsOf(state)[deletedId].removed;
      const revived = await syncOnce(createTestTarget(ctx.sessionPersistence), config, state, () => {});
      assert.equal(revived.created + revived.appended, 1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads only the pending bytes of a large rollout', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-chunk-'));
    try {
      const { sessionsDir, rolloutPath } = writeCodexHome(home);
      const source = createCodexSource({ codexHome: home });
      const read = readPendingTurns({
        source,
        path: rolloutPath,
        offset: 0,
        size: 200,
        dialect: undefined,
        chunkBytes: 64,
        maxChunkBytes: 64,
      });
      assert.equal(read, undefined, 'a partial turn yields nothing to import');
      const full = readPendingTurns({
        source,
        path: rolloutPath,
        offset: 0,
        size: 10_000_000,
        dialect: undefined,
        chunkBytes: 64 * 1024,
        maxChunkBytes: 256 * 1024,
      });
      assert.equal(full.dialect, 'items');
      assert.equal(full.turns.length, 2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('abandons a source file that shrank instead of duplicating its history', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-shrunk-'));
    const shrunkId = 'eeeeeeee-0000-0000-0000-000000000005';
    try {
      const { rolloutPath } = writeCodexHome(home, shrunkId);
      const config = testConfig(home);
      const state = emptyState();
      const first = await syncOnce(createTestTarget(ctx.sessionPersistence), config, state, () => {});
      assert.equal(first.created, 1);

      const sessionId = `session-codex-${shrunkId}`;
      const before = await ctx.sessionPersistence.open(sessionId, 'read');
      const storedBefore = (await before.read()).events.length;
      await before.close();

      writeFileSync(rolloutPath, '{}\n');
      const warnings = [];
      const shrunk = await syncOnce(createTestTarget(ctx.sessionPersistence), config, state, (message) =>
        warnings.push(message)
      );
      assert.equal(shrunk.created + shrunk.appended, 0);
      assert.equal(shrunk.skipped, 1);
      assert.equal(
        warnings.some((message) => message.includes('shrank')),
        true
      );
      assert.equal(typeof sessionsOf(state)[shrunkId].shrunkAt, 'number');

      const after = await syncOnce(createTestTarget(ctx.sessionPersistence), config, state, () => {});
      assert.equal(after.examined, 0, 'a shrunken source is no longer examined');

      const check = await ctx.sessionPersistence.open(sessionId, 'read');
      assert.equal((await check.read()).events.length, storedBefore, 'imported history is preserved');
      await check.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

});
