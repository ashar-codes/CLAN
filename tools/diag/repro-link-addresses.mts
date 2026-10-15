// Discovery address reproduction (docs/DISCOVERY_ROOT_CAUSE.md): what a CLAN link advert publishes on the wire (as
// seen by a plain, unfiltered mDNS browser) and the ranked addresses CLAN's browser hands to callers.
//   node tools/diag/repro-link-addresses.mts
import { Bonjour } from 'bonjour-service';
import { advertiseLinks, browseLinks } from '../../packages/server/src/link-tcp.ts';
import { networkInterfaces } from 'node:os';

const r = 'repro' + Math.random().toString(36).slice(2, 10);
const local = Object.entries(networkInterfaces()).flatMap(([n, a]) => (a ?? []).filter((x) => x.family === 'IPv4' && !x.internal).map((x) => `${n}=${x.address}`));
console.log('this machine:', local.join(' '));
const stop = advertiseLinks({ port: 45678, r });
const raw = new Bonjour({ bind: '0.0.0.0' } as object, () => {});
raw.find({ type: 'clanlink' }).on('up', (s) => { if ((s.txt as { r?: string }).r === r) console.log('on the wire (A records):', JSON.stringify(s.addresses), 'host', s.host); });
const stopB = browseLinks((x) => { if (x.r === r) console.log('CLAN browser addrs (ranked):', JSON.stringify(x.addrs)); });
setTimeout(async () => { stopB(); raw.destroy(); await stop(); process.exit(0); }, 6000);
