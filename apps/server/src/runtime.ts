import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Config } from './config.js';
import { type Migration, WorkbenchDatabase } from './db/database.js';
import { FileBlobStore } from './storage/blobs.js';
import { openDirectories } from './storage/directories.js';
import { MaintenanceGate } from './storage/maintenance.js';

export async function openRuntime(
  config: Config,
  options: {
    migrations?: Migration[];
    onCompromised?: (error: Error) => void;
  } = {},
) {
  const gate = new MaintenanceGate();
  let compromised = false;
  let closing = false;
  const directories = await openDirectories(config, (error) => {
    compromised = true;
    void gate.stop();
    options.onCompromised?.(error);
  });
  let database: WorkbenchDatabase | undefined;
  try {
    const path = resolve(directories.data, 'workbench.sqlite');
    database = new WorkbenchDatabase(path, gate, options.migrations);
    await chmod(path, 0o600);
  } catch (error) {
    database?.close();
    await directories.release();
    throw error;
  }
  const db = database;
  const closeHooks = new Set<() => void | Promise<void>>();
  let closePromise: Promise<void> | undefined;
  return {
    db,
    gate,
    directories,
    blobs: new FileBlobStore(directories.blobs, gate),
    ready: () => !closing && !compromised && gate.available && db.ready(),
    beginShutdown: () => {
      closing = true;
    },
    onClose: (hook: () => void | Promise<void>) => {
      closeHooks.add(hook);
      return () => closeHooks.delete(hook);
    },
    close: (): Promise<void> => {
      closePromise ??= (async () => {
        closing = true;
        let hookError: unknown;
        // Run every cancellation hook and drain storage even if one hook fails.
        for (const hook of closeHooks) {
          try {
            await hook();
          } catch (error) {
            hookError ??= error;
          }
        }
        await gate.stop();
        try {
          db.close();
        } finally {
          await directories.release();
        }
        if (hookError) throw hookError;
      })();
      return closePromise;
    },
  };
}
export type Runtime = Awaited<ReturnType<typeof openRuntime>>;
