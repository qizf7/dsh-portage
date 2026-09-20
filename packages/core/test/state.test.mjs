/**
 * Durable state: the two-namespace document, its legacy migration, and its
 * refusal to guess at an unknown version.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultStatePath,
  emptyState,
  exportAnchors,
  importSessions,
  loadState,
  saveState,
  STATE_VERSION,
} from 'dsh-portage-core';

describe('state document', () => {
  it('resolves one document per external tool under $DSH_HOME', () => {
    assert.equal(defaultStatePath('codex').endsWith(join('dsh-portage', 'codex.json')), true);
    assert.equal(defaultStatePath('kimi').endsWith(join('dsh-portage', 'kimi.json')), true);
  });

  it('round-trips both namespaces', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-portage-state-'));
    try {
      const path = join(home, 'codex.json');
      assert.deepEqual(loadState(path), emptyState());
      const state = emptyState();
      importSessions(state).abc = { offset: 12 };
      exportAnchors(state).def = { exportedAt: 5 };
      await saveState(path, state);
      const loaded = loadState(path);
      assert.equal(loaded.version, STATE_VERSION);
      assert.deepEqual(importSessions(loaded).abc, { offset: 12 });
      assert.deepEqual(exportAnchors(loaded).def, { exportedAt: 5 });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('migrates a version-1 document into the import namespace', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-portage-migrate-'));
    try {
      const path = join(home, 'codex.json');
      writeFileSync(path, JSON.stringify({ version: 1, sessions: { legacy: { offset: 7 } } }));
      const state = loadState(path);
      assert.equal(state.version, STATE_VERSION);
      assert.deepEqual(importSessions(state).legacy, { offset: 7 });
      assert.deepEqual(exportAnchors(state), {});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses an unknown version instead of guessing', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-portage-unknown-'));
    try {
      const path = join(home, 'codex.json');
      writeFileSync(path, JSON.stringify({ version: 99, sessions: { x: { offset: 1 } } }));
      const warnings = [];
      assert.deepEqual(loadState(path, (message) => warnings.push(message)), emptyState());
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /unsupported version 99/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
