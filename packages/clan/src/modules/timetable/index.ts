// Personal timetable aggregate. No remote-control dependencies, CLAN exposure or AI context provider.
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {TimetableDraft,type Timetable,timetableStatus} from '@classroom/protocol';
import {tx,type Db,type ModuleSchema} from '../../core/db.ts';
import type {Principal} from '../../core/permissions.ts';
import {rowProvider,type SyncProvider} from '../../core/syncrows.ts';
export const schema:ModuleSchema={module:'timetable',prefix:'timetable',migrations:[`CREATE TABLE timetable_versions(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,data TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,archived_at INTEGER,deleted_at INTEGER);CREATE INDEX timetable_versions_owner ON timetable_versions(owner_id);CREATE TABLE timetable_selection(owner_id TEXT PRIMARY KEY,active_id TEXT);CREATE TABLE timetable_alerts(owner_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(owner_id,id));`]};
type Row={id:string;owner_id:string;data:string|null;created_at:number;updated_at:number;archived_at:number|null;deleted_at:number|null};
const wire=z.object({id:z.uuid(),data:z.string().max(120000).nullable(),created_at:z.number().int().nonnegative(),updated_at:z.number().int().nonnegative(),archived_at:z.number().int().nonnegative().nullable(),deleted_at:z.number().int().nonnegative().nullable()}).strict();
export class Timetables {
 private db:Db;private now:()=>number;
 constructor(db:Db,now=Date.now){this.db=db;this.now=now;}
 private owner(p:Principal){if(p.kind!=='user')throw Error('Timetable is private; AI access is not authorized.');return p.userId;}
 private selected(owner:string){return (this.db.prepare('SELECT active_id FROM timetable_selection WHERE owner_id=?').get(owner) as {active_id:string}|undefined)?.active_id??null;}
 private view(r:Row):Timetable{return {...TimetableDraft.parse(JSON.parse(r.data!)),id:r.id,owner:r.owner_id,createdAt:r.created_at,updatedAt:r.updated_at,archived:r.archived_at!==null,active:r.archived_at===null&&this.selected(r.owner_id)===r.id};}
 list(p:Principal,archived=false){return (this.db.prepare('SELECT * FROM timetable_versions WHERE owner_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id').all(this.owner(p)) as Row[]).filter(r=>archived||r.archived_at===null).map(r=>this.view(r));}
 get(p:Principal,id:string){const r=this.db.prepare('SELECT * FROM timetable_versions WHERE id=? AND owner_id=? AND deleted_at IS NULL').get(z.uuid().parse(id),this.owner(p)) as Row|undefined;if(!r)throw Error('Timetable not found.');return this.view(r);}
 save(p:Principal,raw:unknown,id?:string){const owner=this.owner(p),draft=TimetableDraft.parse(raw),t=this.now();if(id)this.get(p,id);else if(this.list(p,true).length>=40)throw Error('Up to 40 timetable versions. Delete an obsolete version first; archiving retains it.');const key=id??randomUUID();this.db.prepare('INSERT INTO timetable_versions(id,owner_id,data,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(key,owner,JSON.stringify(draft),t,t);return this.get(p,key);}
 activate(p:Principal,id:string){const v=this.get(p,id);if(v.archived)throw Error('Restore this timetable before selecting it.');this.db.prepare('INSERT INTO timetable_selection(owner_id,active_id) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET active_id=excluded.active_id').run(this.owner(p),id);}
 archive(p:Principal,id:string,on=true){this.get(p,id);tx(this.db,()=>{this.db.prepare('UPDATE timetable_versions SET archived_at=?,updated_at=? WHERE id=?').run(on?this.now():null,this.now(),id);if(on)this.db.prepare('UPDATE timetable_selection SET active_id=NULL WHERE owner_id=? AND active_id=?').run(this.owner(p),id);});}
 duplicate(p:Principal,id:string){const {id:_,owner,createdAt,updatedAt,archived,active,...draft}=this.get(p,id);return this.save(p,{...draft,name:draft.name.slice(0,145)+' (copy)'});}
 remove(p:Principal,id:string){this.get(p,id);tx(this.db,()=>{this.db.prepare('UPDATE timetable_versions SET data=NULL,deleted_at=?,updated_at=? WHERE id=?').run(this.now(),this.now(),id);this.db.prepare('UPDATE timetable_selection SET active_id=NULL WHERE owner_id=? AND active_id=?').run(this.owner(p),id);});}
 current(p:Principal,now=this.now()){const active=this.list(p).find(t=>t.active);return active?{timetable:active,...timetableStatus(active,now)}:null;}
 fileReferences(owner:string){return this.list({kind:'user',userId:owner},true).map(t=>t.imageId).filter((id):id is string=>!!id);}
 syncProviders():SyncProvider[]{return [rowProvider(this.db,{kind:'timetable',policy:'preserve',table:'timetable_versions',owner:'owner_id',toLocal:(_owner,raw)=>{const r=wire.parse(raw);if(r.deleted_at!==null)r.data=null;else{if(r.data===null)throw Error('Missing timetable data');r.data=JSON.stringify(TimetableDraft.parse(JSON.parse(r.data)));}return r;},keepBoth:(owner,_id,remote)=>{const r=wire.parse(remote);if(r.deleted_at!==null)return;const draft=TimetableDraft.parse(JSON.parse(r.data!));this.save({kind:'user',userId:owner},{...draft,name:draft.name.slice(0,130)+' (other device)'});}})];}
}
