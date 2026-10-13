import {randomUUID} from 'node:crypto';
import {TrackSource} from '@livekit/protocol';
import {type ControlView,type ControlPerson} from '@classroom/protocol';
import {RemoteControl} from './remote-control-policy.ts';
import {mediaIdentity} from './presentation.ts';
import type {Principal} from './classroom.ts';
import type {Meetings} from './meeting.ts';
import type {MediaService} from './media.ts';
/** Authenticated host-mediated control; host can see input. No media-token data grants are widened. */
export class MeetingControl {
 private sessions=new Map<string,RemoteControl>();private budgets=new Map<string,{at:number;n:number}>();private meetings:Meetings;private media:MediaService|null;private fence:()=>void;
 constructor(meetings:Meetings,media:MediaService|null,fence:()=>void){this.meetings=meetings;this.media=media;this.fence=fence;}
 async request(p:Principal,room:string,body?:unknown):Promise<ControlView>{this.fence();const key=mediaIdentity(p),now=Date.now();for(const [id,b]of this.budgets)if(now-b.at>60000)this.budgets.delete(id);const budget=this.budgets.get(key);if(budget&&now-budget.at<1000){if(++budget.n>60)throw Error('Control request rate limit.');}else{if(this.budgets.size>=256)throw Error('Control client limit.');this.budgets.set(key,{at:now,n:1});}const state=await this.meetings.state(p),meeting=state.meetings.find(m=>m.id===room),me=mediaIdentity(p);if(!meeting||!meeting.joined.includes(me)||!this.media){throw Error('Join an authorized meeting first.');}
 const peers=await this.media.meetingParticipants(room);this.fence();const active=peers.filter(p=>meeting.joined.includes(p.identity)&&this.meetings.authorized(room,p.identity,p.metadata));
 const screens=active.flatMap(p=>p.tracks.filter(t=>t.source===TrackSource.SCREEN_SHARE && !t.muted).map(t=>({identity:p.identity,screen:t.sid,name:p.name})));
 const live=(target:string,controller:string,screen:string)=>{const a=active.find(p=>p.identity===target),b=active.find(p=>p.identity===controller);return a&&b&&this.meetings.authorized(room,target,a.metadata)&&this.meetings.authorized(room,controller,b.metadata)&&screens.some(s=>s.identity===target&&s.screen===screen)?[room,a.metadata,b.metadata,screen].join(':'):null;};
 let session=this.sessions.get(room);if(!session){if(this.sessions.size>=4){for(const [id,s]of this.sessions)if(!state.meetings.some(m=>m.id===id)){s.clear();this.sessions.delete(id);}}if(this.sessions.size>=4)throw Error('Control room limit.');session=new RemoteControl({id:randomUUID,now:Date.now});this.sessions.set(room,session);}
 if(body!==undefined){const person:ControlPerson=meeting.invited.find(p=>p.identity===me)!;session.action(person,body,live);}
 return session.state(me,screens,live,(body as {action?:string}|undefined)?.action==='pull');
 }
 clear(){for(const s of this.sessions.values())s.clear();this.sessions.clear();this.budgets.clear();}
}
