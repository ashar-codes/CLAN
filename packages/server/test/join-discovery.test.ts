import {afterEach,expect,it} from 'vitest';
import * as opaque from '@serenity-kit/opaque';
import {pairAndJoin} from '@classroom/client';
import {pinnedTransport} from '@classroom/client/node';
import {startClassroomServer,type RunningServer} from '../src/index.ts';
import {device,profile,trustServer} from './helpers.ts';
const servers:RunningServer[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>s.close()));});
async function host(code:string){const s=await startClassroomServer({title:'Disposable join',host:'127.0.0.1',code});servers.push(s);trustServer(s);return s;}
it('late observed host joins securely after a stale/wrong advertisement; no duplicate join or repeated guess',async()=>{
 await opaque.ready;const real=await host('482915'),wrong=await host('991122'),old={url:wrong.bootstrapUrl,sid:wrong.classroom.id},valid={url:real.bootstrapUrl,sid:real.classroom.id};
 const start=performance.now();let starts=0;const plainFetch:typeof fetch=async(u,i)=>{if(String(u).startsWith(wrong.bootstrapUrl)&&String(u).endsWith('/api/pair/start'))starts++;return fetch(u,i);};
 const joined=await pairAndJoin({candidates:[old],candidatesNow:()=>performance.now()-start>150?[old,valid,valid]:[old],discoveryWindowMs:1200,code:'482915',profile:profile(),device:device(),opaque:opaque.client,plainFetch,transportFor:pinnedTransport});
 expect(joined.classroom.sessionId).toBe(real.classroom.id);expect(real.classroom.roster()).toHaveLength(1);expect(wrong.classroom.roster()).toHaveLength(0);expect(starts).toBe(1);
});
it('unknown advertisements cannot grant access; bounded window ends without a member',async()=>{
 await opaque.ready;const wrong=await host('991122'),old={url:wrong.bootstrapUrl,sid:wrong.classroom.id};let starts=0;
 await expect(pairAndJoin({candidates:[old],candidatesNow:()=>[old,old],discoveryWindowMs:300,code:'482915',profile:profile(),device:device(),opaque:opaque.client,plainFetch:async(u,i)=>{if(String(u).endsWith('/api/pair/start'))starts++;return fetch(u,i);},transportFor:pinnedTransport})).rejects.toMatchObject({code:'bad_code'});
 expect(starts).toBe(1);expect(wrong.classroom.roster()).toHaveLength(0);
});

it('an empty bounded discovery produces no-host feedback rather than a fabricated wrong-code result',async()=>{
 await opaque.ready;const started=performance.now();await expect(pairAndJoin({candidates:[],candidatesNow:()=>[],discoveryWindowMs:200,code:'482915',profile:profile(),device:device(),opaque:opaque.client,transportFor:pinnedTransport})).rejects.toMatchObject({code:'none_found'});expect(performance.now()-started).toBeLessThan(1000);
});

it('a slow wrong-code attempt is reported as a wrong code, not as "no CLAN found" (deterministic form of the intermittent failure)',async()=>{
 await opaque.ready;const wrong=await host('991122'),old={url:wrong.bootstrapUrl,sid:wrong.classroom.id};
 // the bounded discovery window ends while the only real attempt is still pairing (a loaded machine / slow Wi-Fi)
 const slow:typeof fetch=async(u,i)=>{await new Promise(r=>setTimeout(r,250));return fetch(u,i);};
 await expect(pairAndJoin({candidates:[old],candidatesNow:()=>[old],discoveryWindowMs:100,code:'482915',profile:profile(),device:device(),opaque:opaque.client,plainFetch:slow,transportFor:pinnedTransport})).rejects.toMatchObject({code:'bad_code'});
 expect(wrong.classroom.roster()).toHaveLength(0);
});
