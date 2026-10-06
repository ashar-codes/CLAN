// One-command dev: build main/preload, serve renderer with HMR, launch Electron.
import { spawn } from 'node:child_process';
import { build, createServer } from 'vite';

await build({ configFile: 'vite.main.config.ts', logLevel: 'warn' });
await build({ configFile: 'vite.preload.config.ts', logLevel: 'warn' });
const server = await createServer({ configFile: 'vite.config.ts', server: { host: '127.0.0.1' } });
await server.listen();
const url = server.resolvedUrls!.local[0]!;
const electron = (await import('electron')).default as unknown as string;
const app = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, CLASSROOM_DEV_URL: url } });
app.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
