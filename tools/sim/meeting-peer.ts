// Disposable native-media fixture: real CLAN pairing/pinning + local SFU, two deterministic Node publishers.
// Its control API binds loopback only. Never run as a product host or against a personal profile.
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {startClassroomServer,candidateInterfaces} from '@classroom/server';
import {device,secureJoin} from '../../packages/server/test/helpers.ts';
import {AudioFrame,AudioSource,AudioStream,LocalAudioTrack,LocalVideoTrack,Room,RoomEvent,TrackPublishOptions,TrackSource,VideoBufferType,VideoFrame,VideoSource,VideoStream,dispose} from '@livekit/rtc-node';
const dir=mkdtempSync(join(tmpdir(),'clan-native-meeting-'));
const s=await startClassroomServer({title:'Native meeting QA',host:candidateInterfaces().find(i=>i.private)!.address,storageDir:dir,hostName:'QA Host',clan:{id:randomUUID(),type:'STUDY_GROUP'},media:{binary:join(import.meta.dirname,'../../native/livekit/bin',`${process.platform}-${process.arch}`,process.platform==='win32'?'livekit-server.exe':'livekit-server'),workDir:join(dir,'media')}});
s.classroom.setPolicy('open');const member=await secureJoin(s,1,device());const host={role:'teacher' as const};const m=await s.meetings.action(host,undefined,{action:'create',mode:'video',title:'Native media QA'}) as {id:string};await s.meetings.action(host,m.id,{action:'invite',identity:member.memberId});
let alive=true;const rooms:Room[]=[],sources:AudioSource[]=[],videos:VideoSource[]=[],producers:Promise<unknown>[]=[],rx=new Map<string,{audio:number;nonSilent:number;video:Set<number>}>();
for(const [principal,name] of [[host,'QA Host'],[{role:'student',memberId:member.memberId},'QA Laptop']] as const){
 const c=await s.meetings.action(principal,m.id,{action:'join'}) as {token:string},r=new Room();rooms.push(r);
 r.on(RoomEvent.TrackSubscribed,(track,_pub,p)=>{if(p.identity===member.memberId || p.identity==='host')return;const counts=rx.get(p.identity) ?? {audio:0,nonSilent:0,video:new Set<number>()};rx.set(p.identity,counts);
  if(track.kind===1)void(async()=>{for await(const frame of new AudioStream(track)){counts.audio++;if(frame.data.some(v=>Math.abs(v)>100))counts.nonSilent++;}})().catch(()=>{});
  else void(async()=>{for await(const event of new VideoStream(track)){let h=0;for(let i=0;i<event.frame.data.length;i+=251)h=(h*31+event.frame.data[i]!)>>>0;counts.video.add(h);}})().catch(()=>{});
 });
 await r.connect(s.media!.signalUrl,c.token,{autoSubscribe:true,dynacast:true});
 const a=new AudioSource(48000,1),ao=new TrackPublishOptions();sources.push(a);ao.source=TrackSource.SOURCE_MICROPHONE;await r.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack(name,a),ao);
 let clock=0;producers.push((async()=>{while(alive){await a.captureFrame(new AudioFrame(Int16Array.from({length:480},(_,i)=>Math.sin((clock*480+i)*Math.PI*2*440/48000)*12000),48000,1,480));clock++;}})().catch(()=>{}));
 const v=new VideoSource(160,120),vo=new TrackPublishOptions();videos.push(v);vo.source=TrackSource.SOURCE_CAMERA;await r.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack(name,v),vo);
 let f=0;const timer=setInterval(()=>{if(!alive){clearInterval(timer);return;}const bytes=new Uint8Array(160*120*4);for(let i=0;i<bytes.length;i+=4){bytes[i]=(f*19+i/4)%256;bytes[i+1]=(f*7)%256;bytes[i+3]=255;}v.captureFrame(new VideoFrame(bytes,160,120,VideoBufferType.RGBA));f++;if(!alive)clearInterval(timer);},100);
}
const timer=setInterval(()=>{for(const p of s.classroom.roster())if(p.id!==member.memberId)void s.meetings.action(host,m.id,{action:'invite',identity:p.id}).catch(()=>{});},3000);
const control=createServer((req,res)=>{void(async()=>{const state=await s.meetings.state(host);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:s.classroom.code,bootstrap:s.bootstrapUrl.replace(/^http:\/\//,''),meeting:m.id,state,received:[...rx].map(([identity,x])=>({identity,audioFrames:x.audio,nonSilentFrames:x.nonSilent,distinctVideoFrames:x.video.size}))}));})().catch(()=>{res.statusCode=500;res.end('{}');});});
control.listen(47498,'127.0.0.1',()=>console.log('Native meeting fixture ready on localhost:47498'));
async function stop(){if(!alive)return;alive=false;clearInterval(timer);control.close();sources.forEach(s=>s.clearQueue());await Promise.all(producers);await Promise.all(rooms.map(r=>r.disconnect()));await Promise.all(sources.map(s=>s.close()));await Promise.all(videos.map(v=>v.close()));await s.close();dispose();rmSync(dir,{recursive:true,force:true});process.exit(0);}
for(const sig of ['SIGINT','SIGTERM'] as const)process.on(sig,()=>void stop());
