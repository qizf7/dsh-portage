/**
 * Plugin-level wiring: validate the documented config, resolve it, and run one
 * real pass through `apply()` against a host-shaped context.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';

import { apply, Config, name, resolveConfig } from '../lib/index.js';
import { CODEX_SESSION_ID, writeCodexHome } from './helpers.mjs';

/**
 * Build the host slice the plugin touches and capture its scheduled passes.
 * @param {object} persistence - session persistence service.
 * @returns {{host: object, scheduled: object[]}} the host and its schedule.
 */
function createHost(persistence) {
  const scheduled = [];
  const warnings = [];
  return {
    scheduled,
    warnings,
    host: {
      sessionPersistence: persistence,
      logger: { info: () => {}, warn: (message) => warnings.push(message) },
      get: () => undefined,
      effect: (fn) => fn(),
      timeout: (fn, ms) => {
        scheduled.push({ kind: 'timeout', fn, ms });
        return () => {};
      },
      interval: (fn, ms) => {
        scheduled.push({ kind: 'interval', fn, ms });
        return () => {};
      },
    },
  };
}

describe('plugin wiring', () => {
  it('validates and resolves the documented bidirectional config', () => {
    const resolved = resolveConfig(Config({ import: { sinceDays: 7 } }));
    assert.equal(name, 'portage-codex');
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.import.enabled, true);
    assert.equal(resolved.import.sinceDays, 7);
    assert.ok(resolved.import.sinceMs > 0, 'a positive window becomes an absolute cut-off');
    assert.equal(resolved.import.roots.length, 1);
    assert.ok(resolved.import.roots[0].endsWith(join('.codex', 'sessions')));
    assert.ok(resolved.statePath.endsWith(join('dsh-portage', 'codex.json')));
    assert.equal(resolved.export.enabled, false, 'the export direction ships disabled');
  });

  it('imports a session through apply() and persists the two-namespace state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-portage-plugin-'));
    const home = mkdtempSync(join(tmpdir(), 'dsh-portage-home-'));
    const ctx = new Context();
    ctx.plugin(JsonlPersistence, { root });
    await ctx.start?.();
    try {
      writeCodexHome(home);
      const { host, scheduled, warnings } = createHost(ctx.sessionPersistence);
      const runner = apply(
        host,
        Config({
          import: { codexHome: home, sessionsDir: join(home, 'sessions') },
          statePath: join(root, 'state.json'),
          startupDelayMs: 1,
        })
      );
      assert.ok(
        scheduled.some((entry) => entry.kind === 'timeout'),
        'apply registered a startup pass'
      );
      assert.ok(
        scheduled.some((entry) => entry.kind === 'interval'),
        'apply registered the recurring pass'
      );
      await runner.run();
      assert.deepEqual(warnings, [], 'the pass reported no problems');

      const handle = await ctx.sessionPersistence.open(`session-codex-${CODEX_SESSION_ID}`, 'read');
      const stored = await handle.read();
      await handle.close();
      assert.ok(stored.events.length > 0);
      assert.equal(stored.events[0].type, 'turn/start');

      const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
      assert.equal(state.version, 2);
      assert.equal(typeof state.import.sessions[CODEX_SESSION_ID].offset, 'number');
      assert.deepEqual(state.export, { anchors: {} });
    } finally {
      await ctx.stop?.();
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
