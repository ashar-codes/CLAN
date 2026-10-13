import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AudioFrame, AudioSource, AudioStream, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, TrackPublishOptions, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream, dispose } from '@livekit/rtc-node';
import { startClassroomServer, candidateInterfaces, type RunningServer, type ServerOptions } from '../src/index.ts';
import { device, secureJoin, tmp, trFor, trustServer } from './helpers.ts';
import { signHostStatement, type AuthorityRecord, type MeetingView, type MeetingState } from '@classroom/protocol';
const lan=candidateInterfaces().find(i=>i.private)?.address;
const binary=join(import.meta.dirname,'../../../native/livekit/bin',`${process.platform}-${process.arch}`,process.platform==='win32'?'livekit-server.exe':'livekit-server');
const servers:RunningServer[]=[],rooms:Room[]=[],stops:(()=>void)[]=[],producers:Promise<unknown>[]=[],receivers:Promise<unknown>[]=[],cancelReaders:(()=>Promise<unknown>)[]=[],closeSources:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{vi.useRealTimers();stops.splice(0).forEach(f=>f());await Promise.all(producers.splice(0));await Promise.all(cancelReaders.splice(0).map(f=>f().catch(()=>{})));await Promise.all(receivers.splice(0));await Promise.all(rooms.splice(0).map(r=>r.disconnect().catch(()=>{})));await Promise.all(closeSources.splice(0).map(f=>f()));await Promise.all(servers.splice(0).map(s=>s.close()));});afterAll(()=>dispose());
const until=async(f:()=>boolean|Promise<boolean>,ms=12000)=>{const end=Date.now()+ms;while(!await f()){if(Date.now()>end)throw Error('timeout: '+f.toString());await new Promise(r=>setTimeout(r,50));}};
async function fixture(n=3,extra:Partial<ServerOptions>={}){const s=await startClassroomServer({title:'Meeting QA',host:lan!,storageDir:tmp('meeting-'),hostName:'Host',clan:{type:'FRIENDS',id:randomUUID()},media:{binary,workDir:tmp('meeting-lk-')},...extra});servers.push(s);trustServer(s);s.classroom.setPolicy('open');const members=[];for(let i=0;i<n;i++)members.push(await secureJoin(s,i+1,device()));return {s,members};}
async function request(s:RunningServer,token:string,body?:unknown,id?:string){const r=await trFor(s.url).fetch(s.url+`/api/meetings${id?'/'+id:''}`,{method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};}
async function token(s:RunningServer,t:string,id:string){return (await request(s,t,{action:'join'},id)).body as {token:string;lease:string};}
async function connect(s:RunningServer,t:string){const room=new Room();rooms.push(room);await room.connect(s.media!.signalUrl,t,{autoSubscribe:true,dynacast:true});return room;}
function receive(room:Room){
 const audio=new Map<string,number>(),video=new Map<string,Set<number>>();
 room.on(RoomEvent.TrackSubscribed,(track,_pub,p)=>{
  if(track.kind===1){const reader=new AudioStream(track).getReader();cancelReaders.push(()=>reader.cancel());receivers.push((async()=>{while(true){const {value:frame,done}=await reader.read();if(done)return;if(frame.data.some(n=>Math.abs(n)>100))audio.set(p.identity,(audio.get(p.identity)??0)+1);}})().catch(()=>{}));}
  else{const reader=new VideoStream(track).getReader();cancelReaders.push(()=>reader.cancel());receivers.push((async()=>{while(true){const {value:e,done}=await reader.read();if(done)return;let h=0;for(let i=0;i<e.frame.data.length;i+=251)h=(h*31+e.frame.data[i]!)>>>0;const values=video.get(p.identity)??new Set<number>();values.add(h);video.set(p.identity,values);}})().catch(()=>{}));}
 });return {audio,video};
}
async function publish(room:Room,video:boolean,source:TrackSource=TrackSource.SOURCE_CAMERA){let alive=true,counter=0;const a=new AudioSource(48000,1);const opts=new TrackPublishOptions();opts.source=TrackSource.SOURCE_MICROPHONE;const audio=LocalAudioTrack.createAudioTrack('qa tone',a);await room.localParticipant!.publishTrack(audio,opts);
 const tone=async()=>{while(alive){const data=Int16Array.from({length:480},(_,i)=>Math.sin((counter*480+i)*2*Math.PI*440/48000)*12000);counter++;await a.captureFrame(new AudioFrame(data,48000,1,480));}};producers.push(tone().catch(()=>{}));closeSources.push(()=>a.close());
 if(video){const v=new VideoSource(160,120);closeSources.push(()=>v.close());const o=new TrackPublishOptions();o.source=source;await room.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('qa changing frames',v),o);let f=0;const tick=()=>{if(!alive)return;const d=new Uint8Array(160*120*4);for(let i=0;i<d.length;i+=4){d[i]=(f*13+i/4)%256;d[i+1]=f%256;d[i+3]=255;}v.captureFrame(new VideoFrame(d,160,120,VideoBufferType.RGBA));f++;setTimeout(tick,66);};tick();}
 stops.push(()=>{alive=false;a.clearQueue();});return audio;
}
describe.skipIf(!lan || !existsSync(binary))('authorized local meetings with real SFU media',()=>{
 it('removal invalidates in-flight credentials even after reinvitation; closed SFU cannot revive',async()=>{
  const {s,members}=await fixture(1),h=s.classroom.teacherToken,who=members[0]!;
  const m=(await request(s,h,{action:'create',mode:'video',title:'Racing invitation'})).body as MeetingView;
  await request(s,h,{action:'invite',identity:who.memberId},m.id);
  const original=s.media!.meetingToken.bind(s.media!);let release!:()=>void,started!:()=>void;
  const ready=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
  const mock=vi.spyOn(s.media!,'meetingToken').mockImplementationOnce(async(...args)=>{const t=await original(...args);started();await gate;return t;});
  const pending=request(s,who.token,{action:'join'},m.id);await ready;
  await request(s,h,{action:'remove',identity:who.memberId},m.id);
  await request(s,h,{action:'invite',identity:who.memberId},m.id);release();
  expect((await pending).status).toBe(403);mock.mockRestore();
  expect((await request(s,who.token,{action:'join'},m.id)).status).toBe(200);
  await s.media!.close();await expect(s.media!.ensure()).rejects.toThrow(/closed/);
 },30000);
 it('host fencing, blocked participants, unauthorized moderation and bounded invitations',async()=>{
  const owner=device(),clanId=randomUUID(),chain:AuthorityRecord[]=[signHostStatement(owner,{type:'clan-host-authority',v:1,clanId,ownerKey:owner.publicKey,epoch:0,hostKey:owner.publicKey,prevHash:null,checkpointHash:null,delegation:null,ack:null,issuedAt:1})];let writable=true;const blocked=new Set<string>();
  const {s,members}=await fixture(2,{clan:{type:'FRIENDS',id:clanId},mediaHostKey:owner.publicKey,mediaBlocked:key=>blocked.has(key),authority:{chain:()=>chain,sign:b=>owner.sign(b),assertWritable:()=>{if(!writable)throw Error('Stale host');}}}),h=s.classroom.teacherToken;
  const m=(await request(s,h,{action:'create',mode:'video',title:'Secured meeting'})).body as MeetingView;
  await request(s,h,{action:'invite',identity:members[0]!.memberId},m.id);
  expect((await request(s,members[0]!.token,{action:'remove',identity:'host'},m.id)).status).toBe(403);
  expect((await request(s,h,{action:'invite',identity:'not-approved'},m.id)).status).toBe(403);
  const credential=await token(s,members[0]!.token,m.id),peer=await connect(s,credential.token);
  blocked.add(s.classroom.member(members[0]!.memberId)!.deviceKey!);await request(s,h);await until(()=>peer.connectionState===0);
  expect((await request(s,members[0]!.token,{action:'join'},m.id)).status).toBe(403);
  const hostCredential=await token(s,h,m.id),host=await connect(s,hostCredential.token);writable=false;
  expect((await request(s,h,{action:'join'},m.id)).status).toBe(503);
  expect((await trFor(s.url).fetch(s.url+'/media/rtc/validate?access_token='+encodeURIComponent(hostCredential.token))).status).toBe(401);
  await until(()=>host.connectionState===0); // authority fencing also terminates already-established media
 },25000);
 it('four simultaneous publishers, late joining, real audio/video frames, mute, removal, rejoin and end',async()=>{
  const {s,members}=await fixture();const h=s.classroom.teacherToken;const m=(await request(s,h,{action:'create',mode:'video',title:'Four peers'})).body as MeetingView;
  for(const p of members)expect((await request(s,h,{action:'invite',identity:p.memberId},m.id)).status).toBe(200);
  const peers:Room[]=[],rx:ReturnType<typeof receive>[]=[];
  for(const [i,t]of [h,...members.map(p=>p.token)].entries()){const credential=await token(s,t,m.id),r=new Room();rooms.push(r);rx.push(receive(r));await r.connect(s.media!.signalUrl,credential.token,{autoSubscribe:true,dynacast:true});peers.push(r);await publish(r,true);if(i===2)await until(()=>rx[0]!.audio.size>=2 && rx[0]!.video.size>=2);}
  await until(()=>rx.every(r=>r.audio.size===3 && [...r.video.values()].filter(v=>v.size>2).length===3),20000);
  expect(((await request(s,h)).body as MeetingState).meetings[0]!.joined).toHaveLength(4);
  const removed=await token(s,members[2]!.token,m.id);expect((await request(s,h,{action:'mute',identity:members[0]!.memberId},m.id)).status).toBe(200);
  await until(async()=>!!(await s.media!.meetingParticipants(m.id)).find(p=>p.identity===members[0]!.memberId)?.tracks.find(t=>Number(t.source)===Number(TrackSource.SOURCE_MICROPHONE))?.muted);
  expect((await request(s,h,{action:'remove',identity:members[2]!.memberId},m.id)).status).toBe(200);
  await until(()=>peers[3]!.connectionState===0); // DISCONNECTED
  expect(s.meetings.authorized(m.id,members[2]!.memberId,removed.lease)).toBe(false);
  expect((await request(s,members[2]!.token,{action:'join'},m.id)).status).toBe(403);
  await request(s,h,{action:'invite',identity:members[2]!.memberId},m.id);const renewed=await token(s,members[2]!.token,m.id);expect(renewed.lease).not.toBe(removed.lease);
  peers[3]=await connect(s,renewed.token);await until(()=>peers[3]!.remoteParticipants.size===3);
  expect((await request(s,h,{action:'end'},m.id)).status).toBe(200);await until(()=>peers.every(p=>p.connectionState===0)).catch(e=>{throw new Error(String(e)+' states='+peers.map(p=>p.connectionState).join(','));});
 },60000);
 it('group audio has three simultaneous decoded non-silent sources and late-join delivery',async()=>{
   const {s,members}=await fixture(2),h=s.classroom.teacherToken,m=(await request(s,h,{action:'create',mode:'audio',title:'Three voices'})).body as MeetingView;
   for(const p of members)await request(s,h,{action:'invite',identity:p.memberId},m.id);
   const rx:ReturnType<typeof receive>[]=[];
   for(const t of [h,...members.map(p=>p.token)]){const r=new Room();rooms.push(r);rx.push(receive(r));const credential=await token(s,t,m.id);await r.connect(s.media!.signalUrl,credential.token,{autoSubscribe:true,dynacast:true});await publish(r,false);}
   await until(()=>rx.every(r=>r.audio.size===2));
   await request(s,h,{action:'end'},m.id);await until(()=>rooms.every(r=>r.connectionState===0));
 },40000);
 it('audio-only grant, consented screen frames and stale/forged/revoked credentials fail closed',async()=>{
  const {s,members}=await fixture(2),h=s.classroom.teacherToken;const m=(await request(s,h,{action:'create',mode:'audio',title:'Audio'})).body as MeetingView;
  expect((await request(s,members[0]!.token,{action:'join'},m.id)).status).toBe(403); // forged invitation
  await request(s,h,{action:'invite',identity:members[0]!.memberId},m.id);
  const credential=await token(s,members[0]!.token,m.id),claims=await s.media!.verifyToken(credential.token);expect(claims.video!.canPublishSources).not.toContain('camera');expect(claims.video!.canPublishSources).toContain('microphone');
  expect((claims.exp!-(claims.nbf??Math.floor(Date.now()/1000)))).toBeLessThanOrEqual(120);
  await expect(s.media!.verifyToken(credential.token.slice(0,-12)+'forged')).rejects.toThrow();
  const gateway=async(t:string)=>trFor(s.url).fetch(s.url+'/media/rtc/validate?access_token='+encodeURIComponent(t));
  expect((await gateway(credential.token)).status).not.toBe(401);
  expect((await gateway(credential.token.slice(0,-12)+'forged')).status).toBe(401);
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+121000);
  await expect(s.media!.verifyToken(credential.token)).rejects.toThrow();expect((await gateway(credential.token)).status).toBe(401);vi.useRealTimers();
  const publisher=await connect(s,credential.token),viewer=new Room();rooms.push(viewer);const rx=receive(viewer);await viewer.connect(s.media!.signalUrl,(await token(s,h,m.id)).token,{autoSubscribe:true,dynacast:true});await publish(publisher,true,TrackSource.SOURCE_SCREENSHARE);
  await until(()=>rx.audio.size===1 && (rx.video.get(members[0]!.memberId)?.size??0)>2);
  const msg={action:'chat',id:randomUUID(),text:'one copy'};await request(s,members[0]!.token,msg,m.id);await request(s,members[0]!.token,msg,m.id);
  expect(((await request(s,h)).body as MeetingState).meetings[0]!.chat).toHaveLength(1);
  s.classroom.setStatus(members[0]!.memberId,'removed');await until(()=>publisher.connectionState===0);expect(s.meetings.authorized(m.id,members[0]!.memberId,credential.lease)).toBe(false);expect((await gateway(credential.token)).status).toBe(401);
  expect((await request(s,members[0]!.token,{action:'join'},m.id)).status).toBe(401);
 },45000);
});
