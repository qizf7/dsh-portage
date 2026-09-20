/**
 * Compose one external tool with DSH into a running sync plugin.
 *
 * The runner owns everything that is the same for every plugin: state loading
 * and saving, the pass loop, counter reporting, and the export direction's
 * enablement check. A plugin supplies its source adapter, its DSH target
 * writer, and — once implemented — its export pass.
 *
 * @module dsh-portage-core/runner
 */

import { createScheduler } from './schedule.js';
import { runImportPass } from './pipeline.js';
import { loadState, saveState } from './state.js';

/**
 * Register one bidirectional sync plugin.
 *
 * @param {object} input - plugin inputs.
 * @param {string} input.name - plugin name, e.g. `portage-codex`.
 * @param {import('./ir.js').SyncHost} input.ctx - plugin context.
 * @param {Record<string, any>} input.config - resolved plugin config.
 * @param {import('./pipeline.js').SourceAdapter} input.source - external tool reader.
 * @param {(ctx: import('./ir.js').SyncHost, config: Record<string, any>) => import('./pipeline.js').TargetWriter} input.createTarget - DSH writer factory.
 * @param {string} input.statePath - durable state document path.
 * @param {(message: string) => void} input.log - diagnostics sink.
 * @param {(() => Promise<Record<string, unknown>>) | undefined} [input.exportPass] - export direction, when this build implements it.
 * @returns {{state: Record<string, unknown>, run: () => Promise<void>}} the loaded state and the guarded pass.
 */
export function registerSyncPlugin(input) {
  const { name, ctx, config, log } = input;
  const state = loadState(input.statePath, log);
  const target = input.createTarget(ctx, config);
  let exportWarned = false;

  const importRun = async () => {
    if (config.import?.enabled !== true) return;
    const counters = await runImportPass({ source: input.source, target, config: config.import, state, log });
    if (counters.created + counters.appended + counters.projected > 0) {
      await saveState(input.statePath, state);
      ctx.logger.info(
        `${name}: created ${counters.created}, appended ${counters.appended}, projected ${counters.projected}, pending ${counters.pending}, failed ${counters.failed}`
      );
    }
  };

  const exportRun = async () => {
    if (config.export?.enabled !== true) return;
    if (input.exportPass === undefined) {
      if (!exportWarned) {
        exportWarned = true;
        log(`${name}: export direction is enabled but this build ships no writer for it yet; ignoring`);
      }
      return;
    }
    const counters = await input.exportPass();
    if (Object.values(counters).some((value) => typeof value === 'number' && value > 0)) {
      await saveState(input.statePath, state);
      ctx.logger.info(`${name}: export ${JSON.stringify(counters)}`);
    }
  };

  const pass = createScheduler({
    ctx,
    name,
    intervalMs: Number(config.intervalMs),
    startupDelayMs: Number(config.startupDelayMs),
    run: async () => {
      await importRun();
      await exportRun();
    },
    log,
  });

  ctx.logger.info(
    `${name}: watching ${(config.import?.roots ?? []).join(', ')} every ${config.intervalMs}ms (state: ${input.statePath})`
  );
  return { state, run: pass };
}
