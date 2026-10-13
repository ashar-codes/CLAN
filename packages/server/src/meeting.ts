// Session-scoped local SFU rooms. All controls run behind CLAN authentication and the host epoch fence.
import { randomUUID } from 'node:crypto';
import { MeetingAction, keyFingerprint, type MeetingView, type MeetingState } from '@classroom/protocol';
import { JoinError, type Classroom, type Principal } from './classroom.ts';
import type { MediaService } from './media.ts';
import { mediaIdentity } from './presentation.ts';
type Live = {view:MeetingView;leases:Map<string,{lease:string;token:string;expiresAt:number}>;removed:Set<string>;versions:Map<string,number>};
export class Meetings {
  private rooms=new Map<string,Live>(); private pending=new Map<string,Promise<unknown>>(); private budget=new Map<string,{at:number;n:number}>();
  private classroom:Classroom; private media:MediaService|null; private fence:()=>void;private blocked:(key:string)=>boolean;private hostKey?:string;
  constructor(classroom:Classroom,media:MediaService|null,fence:()=>void,blocked:(key:string)=>boolean=()=>false,hostKey?:string) { this.classroom=classroom;this.media=media;this.fence=fence;this.blocked=blocked;this.hostKey=hostKey; }
  private name(id:string) { return id==='host' ? this.classroom.hostName ?? 'Host' : this.classroom.member(id)?.fullName ?? 'Member'; }
  private approved(id:string) { const key=id==='host'?null:this.classroom.member(id)?.deviceKey;return (!key || !this.blocked(key)) && (id==='host' || this.classroom.status(id)==='approved'); }
  private person(id:string){const key=id==='host'?this.hostKey:this.classroom.member(id)?.deviceKey;return {identity:id,name:this.name(id),...(key?{fingerprint:keyFingerprint(key)}:{})};}
  private allowed(r:Live,id:string) { return this.approved(id) && !r.removed.has(id) && r.view.invited.some(p=>p.identity===id); }
  private own(r:Live,id:string) { if(id!=='host' && id!==r.view.owner) throw new JoinError(403,'forbidden','Only the meeting organizer or CLAN host may moderate.'); }
  private async prune(){for(const [id,r] of this.rooms)if(!this.approved(r.view.owner) || Date.now()-r.view.startedAt>2*60*60*1000){this.rooms.delete(id);await this.media?.meetingEnd(id);}else for(const identity of [...r.leases.keys()])if(!this.approved(identity)){r.versions.set(identity,(r.versions.get(identity) ?? 0)+1);r.leases.delete(identity);await this.media?.meetingRemove(id,identity);}}
  async sweep(){this.fence();await this.prune();}
  async state(p:Principal):Promise<MeetingState> {
    this.fence(); await this.prune();const me=mediaIdentity(p);
    const meetings:MeetingView[]=[];
    for(const [id,r] of this.rooms) if(this.allowed(r,me)) {
      const live=await this.media?.meetingParticipants(id).catch(()=>[]) ?? [];
      meetings.push({...r.view,invited:r.view.invited.filter(x=>this.allowed(r,x.identity)),hands:r.view.hands.filter(id=>live.some(p=>p.identity===id)),joined:live.filter(x=>this.allowed(r,x.identity) && r.leases.get(x.identity)?.lease===x.metadata).map(x=>x.identity)});
    }
    return {me,canCreate:!!this.media && (p.role==='teacher' || this.classroom.can(p,'PRESENT')),members:this.classroom.can(p,'VIEW_MEMBERS') ? [this.person('host'),...this.classroom.roster().filter(m=>m.status==='approved').filter(m=>this.approved(m.id)).map(m=>this.person(m.id))] : [],meetings};
  }
  async action(p:Principal,id:string|undefined,raw:unknown):Promise<unknown> {
    this.fence(); if(!this.media) throw new JoinError(503,'media_unavailable','A desktop CLAN host with local media is required.');
    await this.prune();const parsed=MeetingAction.safeParse(raw);if(!parsed.success)throw new JoinError(400,'invalid','Invalid meeting control.');const a=parsed.data,me=mediaIdentity(p),now=Date.now();
    const b=this.budget.get(me) ?? {at:now,n:0}; if(now-b.at>=60000){b.at=now;b.n=0;} this.budget.set(me,b);
    if(++b.n>60) throw new JoinError(429,'rate_limited','Too many meeting controls.');
    if(a.action==='create') {
      if(!(p.role==='teacher' || this.classroom.can(p,'PRESENT'))) throw new JoinError(403,'forbidden','Ask the CLAN host to start a meeting.');
      if(this.rooms.size>=4) throw new JoinError(429,'limit','At most four meetings per CLAN host.');
      const room=`m-${randomUUID()}`;
      const view:MeetingView={id:room,title:a.title,mode:a.mode,owner:me,startedAt:now,invited:[this.person(me),...(me==='host'?[]:[this.person('host')])],joined:[],hands:[],chat:[]};
      this.rooms.set(room,{view,leases:new Map(),removed:new Set(),versions:new Map()}); return view;
    }
    const r=id && this.rooms.get(id); if(!r || !this.allowed(r,me)) throw new JoinError(403,'forbidden','Meeting invitation is absent, expired or revoked.');
    if(a.action==='join') {
      const key=`${id}:${me}`; if(this.pending.has(key)) return this.pending.get(key)!;
      const job=(async()=>{
        const version=r.versions.get(me) ?? 0;
        const cached=r.leases.get(me); if(cached && cached.expiresAt>Date.now()+10000) return cached;
        if(!cached && r.leases.size>=8) throw new JoinError(409,'full','This meeting supports up to eight participants.');
        const lease=cached?.lease ?? randomUUID();
        const t=await this.media!.meetingToken(id!,me,this.name(me),lease,r.view.mode==='video');
        this.fence(); if(this.rooms.get(id!)!==r || !this.allowed(r,me) || (r.versions.get(me) ?? 0)!==version) throw new JoinError(403,'forbidden','Meeting access changed.');
        const credential={...t,lease};r.leases.set(me,credential);return credential;
      })().finally(()=>this.pending.delete(key)); this.pending.set(key,job);return job;
    }
    if(a.action==='decline'){r.versions.set(me,(r.versions.get(me) ?? 0)+1);r.removed.add(me);r.leases.delete(me);await this.media.meetingRemove(id!,me);return {ok:true};}
    if(a.action==='leave'){r.versions.set(me,(r.versions.get(me) ?? 0)+1);r.leases.delete(me);r.view.hands=r.view.hands.filter(x=>x!==me);await this.media.meetingRemove(id!,me);return {ok:true};}
    if(a.action==='hand' || a.action==='chat') {
      if(!r.leases.has(me) || !(await this.media.meetingParticipants(id!)).some(p=>p.identity===me && p.metadata===r.leases.get(me)?.lease)) throw new JoinError(403,'forbidden','Join the meeting first.');
      this.fence();if(!this.allowed(r,me))throw new JoinError(403,'forbidden','Meeting access changed.');
      if(a.action==='hand'){r.view.hands=r.view.hands.filter(x=>x!==me);if(a.raised)r.view.hands.push(me);}
      else if(!r.view.chat.some(m=>m.id===a.id && m.identity===me)){r.view.chat.push({id:a.id,identity:me,name:this.name(me),text:a.text,at:now});r.view.chat=r.view.chat.slice(-100);}
      return {ok:true};
    }
    this.own(r,me);
    if(a.action==='end'){this.rooms.delete(id!);r.leases.clear();await this.media.meetingEnd(id!);return {ok:true};}
    if(!this.approved(a.identity)) throw new JoinError(403,'forbidden','That participant is not an approved CLAN member.');
    if(a.action==='invite'){if(!r.view.invited.some(x=>x.identity===a.identity)){if(r.view.invited.length>=8)throw new JoinError(409,'full','Up to eight invited participants.');r.view.invited.push(this.person(a.identity));}r.removed.delete(a.identity);}
    else if(a.action==='remove'){if(a.identity==='host')throw new JoinError(403,'forbidden','The CLAN host cannot be removed.');r.versions.set(a.identity,(r.versions.get(a.identity) ?? 0)+1);r.removed.add(a.identity);r.leases.delete(a.identity);r.view.hands=r.view.hands.filter(x=>x!==a.identity);await this.media.meetingRemove(id!,a.identity);}
    else await this.media.meetingMute(id!,a.identity);
    return {ok:true};
  }
  /** Gateway checks JWT and the current membership/lease; a previously issued token is insufficient after leave/removal. */
  authorized(room:string,identity:string,lease:unknown) { const r=this.rooms.get(room);return !!r && Date.now()-r.view.startedAt<=2*60*60*1000 && this.allowed(r,identity) && r.leases.get(identity)?.lease===lease; }
  async revoked(identity:string) { for(const [id,r] of this.rooms){if(r.view.owner===identity){this.rooms.delete(id);await this.media?.meetingEnd(id);continue;}r.versions.set(identity,(r.versions.get(identity) ?? 0)+1);r.removed.add(identity);r.leases.delete(identity);r.view.hands=r.view.hands.filter(x=>x!==identity);await this.media?.meetingRemove(id,identity);} }
  async end(){const ids=[...this.rooms.keys()];this.rooms.clear();await Promise.all(ids.map(id=>this.media?.meetingEnd(id)));}
}
