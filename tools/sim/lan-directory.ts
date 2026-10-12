// Administrator service: existing provisioned TLS files + explicit device public-key enrollment. No key generation.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { startLanDirectory } from '@classroom/server';
const path = process.argv[2]; if (!path) throw Error('Usage: node tools/sim/lan-directory.ts /path/to/admin-config.json');
const c = z.object({ host: z.string(), port: z.number().int().min(1).max(65535), certFile: z.string(), keyFile: z.string(), spkiSha256: z.string().min(40).max(64), allowedKeys: z.array(z.string().regex(/^[A-Za-z0-9_-]{43}$/)).min(1).max(256) }).strict().parse(JSON.parse(await readFile(path, 'utf8')));
const directory = await startLanDirectory({ host: c.host, port: c.port, allowedKeys: new Set(c.allowedKeys), tls: { certPem: await readFile(c.certFile, 'utf8'), keyPem: await readFile(c.keyFile, 'utf8'), spkiSha256: c.spkiSha256 } });
console.log(`CLAN LAN directory listening on the configured internal interface, port ${directory.port}; forwarding disabled.`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void directory.close().then(() => process.exit(0)); });
