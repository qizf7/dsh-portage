/**
 * `dsh-portage-codex` — Codex ↔ DSH sync plugin.
 *
 * One plugin, both directions: `import` mirrors Codex rollout history into DSH
 * sessions, `export` (not implemented in this build) will write DSH sessions
 * back through Codex's external-session import path.
 *
 * @module dsh-portage-codex
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { createDshWriter, defaultStatePath, registerSyncPlugin } from 'dsh-portage-core';
import { createCodexSource } from '../src/codex/adapter.js';

/** External tool name; also the state file name. */
export const TOOL = 'codex';

/** Cordis plugin name. */
export const name = 'portage-codex';

/** Services this plugin needs before it can run. */
export const inject = ['sessionPersistence', 'timer'];

/** Plugin configuration. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.natural().min(5000).default(60000),
  startupDelayMs: z.natural().default(15000),
  statePath: z.string().default(''),
  import: z.object({
    enabled: z.boolean().default(true),
    sessionsDir: z.string().default(''),
    codexHome: z.string().default(''),
    includeArchived: z.boolean().default(false),
    newestFirst: z.boolean().default(true),
    autoCreateWorkspaces: z.boolean().default(true),
    includeSubagentRollouts: z.boolean().default(false),
    denyCwdIncludes: z.array(z.string()).default(['/.codex/worktrees/']),
    minUserMessages: z.natural().default(1),
    sinceDays: z.natural().default(0),
    maxSessionsPerTick: z.natural().min(1).default(25),
    maxFilesPerTick: z.natural().min(1).default(200),
    maxReprojectPerTick: z.natural().min(1).default(200),
    maxFileBytes: z.natural().default(0),
    toolOutputMaxChars: z.natural().default(8000),
    chunkBytes: z.natural().min(65536).default(4 * 1024 * 1024),
    maxChunkBytes: z.natural().min(65536).default(64 * 1024 * 1024),
    deferRetryMs: z.natural().default(6 * 3600 * 1000),
    reimportDeleted: z.boolean().default(false),
    agentPreset: z.string().default('standard'),
  }),
  export: z.object({
    enabled: z.boolean().default(false),
    projectAllowlist: z.array(z.string()).default([]),
  }),
});

/**
 * Resolve one configured path, expanding `~` and falling back to a default.
 * @param {string} configured - configured value.
 * @param {string} fallback - default value.
 * @returns {string} an absolute path.
 */
function resolvePath(configured, fallback) {
  if (configured.length === 0) return fallback;
  return configured.startsWith('~') ? join(homedir(), configured.slice(1)) : configured;
}

/**
 * Resolve the plugin configuration into pipeline-ready values.
 * @param {Record<string, any>} config - validated plugin config.
 * @returns {Record<string, any>} resolved config.
 */
export function resolveConfig(config) {
  const codexHome = resolvePath(String(config.import?.codexHome ?? ''), join(homedir(), '.codex'));
  const roots = [resolvePath(String(config.import?.sessionsDir ?? ''), join(codexHome, 'sessions'))];
  if (config.import?.includeArchived === true) roots.push(join(codexHome, 'archived_sessions'));
  return {
    ...config,
    import: {
      ...config.import,
      codexHome,
      roots,
      sinceMs:
        Number(config.import?.sinceDays ?? 0) > 0
          ? Date.now() - Number(config.import.sinceDays) * 86400000
          : 0,
    },
    statePath: resolvePath(String(config.statePath ?? ''), defaultStatePath(TOOL)),
  };
}

/**
 * Register the Codex sync plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, any>} config - validated plugin config.
 * @returns {{state: Record<string, unknown>, run: () => Promise<void>} | undefined} the runner.
 *   Returned so tests can drive a pass deterministically; the harness ignores it.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const log = (message) => ctx.logger.warn(message);
  if (resolved.enabled !== true) {
    ctx.logger.info(`${name}: disabled by configuration`);
    return;
  }
  return registerSyncPlugin({
    name,
    // The host context carries these services at runtime; the structural type only
    // spares the core a dependency on harness service augmentations.
    ctx: /** @type {import('dsh-portage-core').SyncHost} */ (/** @type {unknown} */ (ctx)),
    config: resolved,
    source: createCodexSource(resolved.import),
    createTarget: (targetCtx, pluginConfig) =>
      createDshWriter(targetCtx, {
        tool: TOOL,
        autoCreateWorkspaces:
          /** @type {Record<string, any>} */ (pluginConfig).import?.autoCreateWorkspaces === true,
        defaultProvider: 'openai',
        defaultModel: 'gpt-5-codex',
        log,
      }),
    statePath: resolved.statePath,
    log,
  });
}
