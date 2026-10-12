import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { startLanDirectory } from '../src/lan-directory.ts';
import { createClassroomTls } from '../src/tls.ts';
import { newEd25519, nodeSigner, pinnedTransport } from '@classroom/client/node';
import { lanDirectoryClient, peerAuthHeaders, LanDirectoryAgent } from '@classroom/client';
import { directoryConfig, internalEndpoint, orderLanRoutes, sameSubnet, type DirectoryAdvert } from '@classroom/protocol';
const stops: (() => unknown)[] = []; afterAll(async () => { for (const f of stops.reverse()) await f(); });
const signer = () => nodeSigner(newEd25519().privatePkcs8), nonce = () => randomBytes(18).toString('base64url');
async function fixture() {
  const a = signer(), b = signer(), m = signer(), tls = await createClassroomTls('directory fixture', Date.now(), 86400000), allowedKeys = new Set([a.publicKey,b.publicKey]); let now = Date.now();
  const server = await startLanDirectory({ tls, allowedKeys, host: '127.0.0.1', now: () => now, allowLoopback: true }); stops.push(() => server.close());
  const config = { url: `https://127.0.0.1:${server.port}`, certificate: tls.certificate, spkiSha256: tls.spkiSha256 };
  const client = (s: typeof a) => lanDirectoryClient({ config, signer: s, fetch: pinnedTransport(tls).fetch, nonce, allowLoopback: true });
  return { a,b,m,server,tls,config,allowedKeys,client, setTime: (n: number) => { now = n; } };
}
const advert: DirectoryAdvert = { kind: 'link', r: 'rotating-id-123456', endpoints: ['10.72.0.2:7010'] };
describe('administrator LAN directory security and routing', () => {
  it('authenticated registration/lookup carries opaque hints only, expires and enforces enrollment revocation', async () => {
    const f = await fixture(); await f.client(f.a).register([advert]); const found = await f.client(f.b).lookup(); expect(found.adverts).toEqual([advert]); expect(JSON.stringify(found)).not.toContain(f.a.publicKey);
    await expect(f.client(f.m).lookup()).rejects.toThrow('enrollment');
    f.allowedKeys.delete(f.a.publicKey); expect((await f.client(f.b).lookup()).adverts).toEqual([]); f.allowedKeys.add(f.a.publicKey);
    await f.client(f.a).register([advert]); f.setTime(Date.now()+91000); expect((await f.client(f.b).lookup()).adverts).toEqual([]);
  });
  it('rejects forged, replayed, wrong-recipient and tampered-body requests', async () => {
    const f = await fixture(), body = JSON.stringify({ adverts: [advert] }), headers = peerAuthHeaders(f.a, { method: 'POST', path: '/lan/register', body, to: f.tls.spkiSha256, nonce: nonce() });
    const post = (h = headers, payload = body) => f.server.app.inject({ method: 'POST',url: '/lan/register',headers: { ...h, 'content-type':'application/json' },payload });
    expect((await post()).statusCode).toBe(200); expect((await post()).statusCode).toBe(401); expect((await post(headers, '{}')).statusCode).toBe(401);
    expect((await post({ ...headers,'x-clan-peer-sig': 'forged' })).statusCode).toBe(401);
    expect((await post(peerAuthHeaders(f.a,{ method:'POST',path:'/lan/register',body,to:'other-directory',nonce:nonce() }))).statusCode).toBe(401);
  });
  it('rejects unsafe endpoints, arbitrary metadata, oversized registration and flood without outbound scanning', async () => {
    const f = await fixture();
    for (const endpoints of [['8.8.8.8:443'],['010.1.1.1:8000'],['10.0.0.1:65536'],['localhost:80'],['[fc::1]:443']]) await expect(f.client(f.a).register([{ ...advert,endpoints }])).rejects.toThrow();
    await expect(f.client(f.a).register([{ ...advert, key: f.a.publicKey } as DirectoryAdvert])).rejects.toThrow();
    const response = await f.server.app.inject({ method:'POST',url:'/lan/register',headers: { 'content-type':'application/json' },payload:' '.repeat(17000) }); expect(response.statusCode).toBe(413);
    for(let i=0;i<241;i++) await f.server.app.inject({ method:'POST',url:'/lan/lookup',headers:{'content-type':'application/json'},payload:'{}' });
    expect((await f.server.app.inject({ method:'POST',url:'/lan/lookup',headers:{'content-type':'application/json'},payload:'{}' })).statusCode).toBe(429);
  });
  it('certificate pin mismatch fails; public endpoints, redirects, credentials and invalid IPv6 rejected', async () => {
    const f = await fixture(), other = await createClassroomTls('wrong pin',Date.now(),86400000);
    await expect(lanDirectoryClient({ config:f.config,signer:f.a,nonce,fetch:pinnedTransport(other).fetch,allowLoopback:true }).lookup()).rejects.toThrow();
    for (const url of ['http://10.0.0.1:444','https://8.8.8.8:443','https://user:pass@10.0.0.1:443','https://10.0.0.1/path','https://10.0.0.1/?x=1']) expect(()=>directoryConfig({...f.config,url})).toThrow();
    expect(internalEndpoint('[fd12::1]:7000')).toBe(true); expect(directoryConfig({...f.config,url:'https://[fd12::1]:7000'}).url).toBe('https://[fd12::1]:7000');
    let forwarded = 0;
    const target = httpServer((_req,res) => { forwarded++; res.end('{}'); });
    await new Promise<void>(resolve => target.listen(0,'127.0.0.1',resolve));
    const redirect = createServer({ cert:f.tls.certPem,key:f.tls.keyPem,minVersion:'TLSv1.3' }, (_req,res) => {
      res.writeHead(307,{location:`http://127.0.0.1:${(target.address() as {port:number}).port}/stolen`});res.end();
    });
    await new Promise<void>(resolve => redirect.listen(0,'127.0.0.1',resolve));
    try {
      const c = lanDirectoryClient({config:{...f.config,url:`https://127.0.0.1:${(redirect.address() as {port:number}).port}`},signer:f.a,nonce,fetch:pinnedTransport(f.tls).fetch,allowLoopback:true});
      await expect(c.lookup()).rejects.toThrow(); expect(forwarded).toBe(0);
    } finally { await new Promise<void>(resolve=>redirect.close(()=>resolve())); await new Promise<void>(resolve=>target.close(()=>resolve())); }
  });
  it('same-subnet ranking uses real masks; routed/isolated hints grant no connected state', () => {
    const networks=[{address:'10.71.1.2',netmask:'255.255.0.0'}]; expect(sameSubnet('tcp:10.71.9.4:7000',networks)).toBe(true); expect(sameSubnet('tcp:10.72.1.4:7000',networks)).toBe(false);
    expect(orderLanRoutes(['tcp:10.72.1.4:7000','tcp:10.71.9.4:7000'],networks)).toEqual(['tcp:10.71.9.4:7000','tcp:10.72.1.4:7000']);
  });
  it('an old in-flight lookup cannot republish hints after disable; requests coalesce', async () => {
    let resolve!: (v: {ttlMs:number;adverts:DirectoryAdvert[]})=>void, lookups=0; const received: DirectoryAdvert[][]=[];
    const agent=new LanDirectoryAgent(()=>[],(ads)=>received.push(ads)); agent.configure({register:async()=>({ok:true}),lookup:()=>{lookups++;return new Promise(r=>{resolve=r;});}});
    const a=agent.refresh(true),b=agent.refresh(true); await new Promise(r=>setTimeout(r,0));expect(lookups).toBe(1);agent.configure(null);resolve({ttlMs:90000,adverts:[advert]});await Promise.all([a,b]);expect(received.every(x=>x.length===0)).toBe(true);
  });
});
