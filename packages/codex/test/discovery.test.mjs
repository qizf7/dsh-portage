/**
 * Codex on-disk discovery: rollout filenames, nested directories, and absolute
 * path handling for both separator styles.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isAbsolutePath } from 'dsh-portage-core';
import { discoverRollouts, sessionIdFromFilename } from '../src/codex/pending.js';
import { CODEX_SESSION_ID, writeCodexHome } from './helpers.mjs';

describe('rollout discovery', () => {
  it('derives session ids from filenames and walks nested directories', () => {
    assert.equal(
      sessionIdFromFilename(`rollout-2026-03-09T14-19-05-${CODEX_SESSION_ID}.jsonl`),
      CODEX_SESSION_ID
    );
    const home = mkdtempSync(join(tmpdir(), 'codex-walk-'));
    try {
      const { sessionsDir } = writeCodexHome(home);
      const found = discoverRollouts(sessionsDir);
      assert.equal(found.length, 1);
      assert.equal(found[0].key, CODEX_SESSION_ID);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('recognizes absolute paths on both separator styles', () => {
    assert.equal(isAbsolutePath('/tmp/x'), true);
    assert.equal(isAbsolutePath('C:\\work'), true);
    assert.equal(isAbsolutePath(''), false);
    assert.equal(isAbsolutePath('relative/path'), false);
  });
});
