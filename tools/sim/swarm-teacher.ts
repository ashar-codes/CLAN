// Child process: the teacher for bench-swarm.ts (own process so its CPU/RSS/bytes are measured in isolation).
import { startClassroomServer } from '@classroom/server';

const [host, chunkSize] = [process.argv[2] ?? '127.0.0.1', Number(process.argv[3] ?? 1048576)];
const s = await startClassroomServer({ title: 'Swarm bench', host, limits: { chunkSize, pairInflightPerSource: 10_000, downloadRequestsPerMinute: 10_000_000, maxDownloadsTotal: 1024 } });
s.classroom.setPolicy('open');
process.send!({ t: 'ready', url: s.url, bootstrapUrl: s.bootstrapUrl, sessionId: s.classroom.id, code: s.classroom.code, tls: s.tls, teacherKey: s.teacherPublicKey });
process.on('message', async (m: { t: string; path?: string; on?: boolean }) => {
  if (m.t === 'import') { const r = await s.resources.importFile(m.path!); process.send!({ t: 'imported', resource: { id: r.id, name: r.name, size: r.size, sha256: r.sha256 } }); }
  if (m.t === 'peerAssist') { s.classroom.setPeerAssist(!!m.on); process.send!({ t: 'ok' }); }
  if (m.t === 'stats') process.send!({ t: 'stats', cpu: process.cpuUsage(), maxRssKb: process.resourceUsage().maxRSS, servedBytes: s.resources.stats(0).servedBytes });
  if (m.t === 'stop') { await s.close(); process.exit(0); }
});
