import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';

type IsolatedBackend = { baseURL: string; dataDir: string };

export const test = base.extend<{ backend: IsolatedBackend }>({
  backend: async ({}, use) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'zhiyu-browser-permissions-'));
    let process: ChildProcess | undefined;
    try {
      const socket = createServer();
      socket.listen(0, '127.0.0.1');
      await once(socket, 'listening');
      const port = (socket.address() as { port: number }).port;
      await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
      const baseURL = `http://127.0.0.1:${port}`;
      let output = '';
      process = spawn(globalThis.process.execPath, ['server/index.mjs'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...globalThis.process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [process.stdout, process.stderr]) stream?.on('data', value => { output += value.toString(); });
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (process.exitCode !== null) throw new Error(`Isolated API exited (${process.exitCode}): ${output}`);
        try { ready = (await fetch(`${baseURL}/api/session`)).ok; } catch { /* Starting. */ }
        if (ready) break;
        await delay(200);
      }
      if (!ready) throw new Error(`Isolated API did not become ready: ${output}`);
      await use({ baseURL, dataDir });
    } finally {
      if (process && process.exitCode === null && process.signalCode === null) {
        const exited = once(process, 'exit');
        process.kill('SIGTERM');
        // A browser keepalive request can outlive the page. Bound shutdown so
        // fixture cleanup still removes its isolated data directory.
        const forceStop = setTimeout(() => process?.kill('SIGKILL'), 10_000);
        try { await exited; }
        finally { clearTimeout(forceStop); }
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  },
});

export { expect } from '@playwright/test';
