/**
 * One bounded, single-flight pass loop for a plugin.
 *
 * Both directions of a bidirectional plugin share one loop: a pass runs the
 * import direction and then the export direction, so two passes never race on
 * the same state document.
 *
 * @module dsh-portage-core/schedule
 */

/**
 * Start the plugin's recurring pass.
 *
 * @param {object} input - schedule inputs.
 * @param {import('./ir.js').SyncHost} input.ctx - plugin context.
 * @param {string} input.name - plugin name used in effect labels and diagnostics.
 * @param {number} input.intervalMs - delay between passes.
 * @param {number} input.startupDelayMs - delay before the first pass.
 * @param {() => Promise<void>} input.run - one full pass.
 * @param {(message: string) => void} input.log - diagnostics sink.
 * @returns {() => Promise<void>} the guarded pass, for tests and manual runs.
 */
export function createScheduler(input) {
  let running = false;
  const pass = async () => {
    if (running) return;
    running = true;
    try {
      await input.run();
    } catch (error) {
      input.log(`${input.name}: pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  input.ctx.effect(
    () => input.ctx.timeout(() => void pass(), input.startupDelayMs),
    `${input.name}.startup`
  );
  input.ctx.effect(
    () => input.ctx.interval(() => void pass(), input.intervalMs),
    `${input.name}.interval`
  );
  return pass;
}
