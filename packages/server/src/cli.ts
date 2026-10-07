// Headless teacher server for development, LAN smoke tests and benchmarks.
// Usage: node packages/server/src/cli.ts [--title "Operating Systems"] [--host 192.168.1.20] [--port 0] [--db file.db]
import { parseArgs } from 'node:util';
import { startClassroomServer } from './server.ts';
import { candidateInterfaces } from './netinfo.ts';

const { values } = parseArgs({ options: { title: { type: 'string', default: 'Demo Class' }, host: { type: 'string' }, port: { type: 'string', default: '0' }, db: { type: 'string', default: ':memory:' } } });
const host = values.host ?? candidateInterfaces()[0]?.address ?? '127.0.0.1';
const s = await startClassroomServer({ title: values.title!, host, port: Number(values.port), dbPath: values.db, advertise: true });
// Dev tool: prints the code for the operator. Never the teacher token or any key material.
console.log(JSON.stringify({ url: s.url, bootstrapUrl: s.bootstrapUrl, code: s.classroom.code, sessionId: s.classroom.id, spkiSha256: s.tls.spkiSha256 }));
const stop = async () => { await s.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
