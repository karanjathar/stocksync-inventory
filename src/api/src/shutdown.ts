export interface ShutdownStep { name: string; run: () => Promise<void> }
export interface ShutdownOptions { timeoutMs: number; exit: (code: number) => void; log: (msg: string, data?: object) => void }

/**
 * Graceful shutdown: runs the steps in order (stop accepting requests → stop scheduling → drain jobs → close the pool).
 * A failing step is logged and the rest still run; a hung step is cut off after `timeoutMs` with exit code 1.
 * Only the first signal does anything.
 */
export function createShutdown(steps: ShutdownStep[], { timeoutMs, exit, log }: ShutdownOptions): (signal: string) => Promise<void> {
  let started = false;
  return async (signal) => {
    if (started) return;
    started = true;
    log('shutting down', { signal });
    const force = setTimeout(() => { log('shutdown timed out, forcing exit', { timeoutMs }); exit(1); }, timeoutMs);
    force.unref();
    let failed = false;
    for (const step of steps) {
      try {
        await step.run();
      } catch (err) {
        failed = true;
        log(`shutdown step "${step.name}" failed`, { err: String(err) });
      }
    }
    clearTimeout(force);
    exit(failed ? 1 : 0);
  };
}
