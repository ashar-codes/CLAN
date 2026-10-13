import {expect,it} from 'vitest';
import {setup,user,file} from './helpers.ts';
it('course archive/restore/delete keeps independent notes, tasks, files and CLAN ownership',async()=>{
 const {app,db,storageDir}=setup(),me=user(app.me),other=user('other');try{
 const course=app.courses.create(me,{name:'Disposable course'}),topic=app.courses.addTopic(me,course.id,'Topic');
 const note=app.notes.create(me,{title:'Independent note',body:'Keep'}),f=await app.files.add(me,file(storageDir,'keep.txt','keep'),'keep.txt',{kind:'personal',ownerId:app.me});
 app.courses.link(me,course.id,{module:'notes',entityId:note.id,topicId:topic.id});app.courses.link(me,course.id,{module:'files',entityId:f.refId});
 const task=app.tasks.create(me,{title:'Independent task',courseId:course.id}),exam=app.exams.create(me,{courseId:course.id,name:'Retained exam',at:Date.now()+60000});
 expect(()=>app.courses.remove(other,course.id)).toThrow();app.courses.archive(me,course.id);expect(app.courses.list(me)).toHaveLength(0);expect(app.courses.list(me,true)).toHaveLength(1);app.courses.restore(me,course.id);expect(app.courses.mine(me,course.id).name).toBe('Disposable course');
 app.courses.remove(me,course.id);expect(()=>app.courses.mine(me,course.id)).toThrow();expect(()=>app.courses.restore(me,course.id)).toThrow();expect(app.notes.get(me,note.id)).not.toBeNull();expect(app.files.get(me,f.refId)).not.toBeNull();expect(app.tasks.get(me,task.id)).not.toBeNull();expect(app.exams.prep(me,exam.id).exam.name).toBe('Retained exam');expect(app.courses.context(other,course.id)).toBeNull();expect(app.courses.syncProviders()[0]!.one(app.me,course.id)).toBeNull();expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{db.close();}
});
it('destructive Study APIs require the owner, deny reader agents, and remove only owned children',()=>{
 const {app,db}=setup(),me=user(app.me),other=user('other'),agent={kind:'agent' as const,onBehalfOf:app.me,agentId:'reader',scopes:['tasks:read','courses:read']};try{
 const c=app.courses.create(me,{name:'Course'}),t=app.tasks.create(me,{title:'Task',checklist:['One']}),e=app.exams.create(me,{courseId:c.id,name:'Exam',at:Date.now()+60000}),d=app.flashcards.createDeck(me,{name:'Deck'}),card=app.flashcards.addCard(me,d.id,{front:'Question',back:'Answer'});app.flashcards.review(me,card.id,'good');
 for(const p of [other,agent]){expect(()=>app.tasks.remove(p,t.id)).toThrow();expect(()=>app.tasks.update(p,t.id,{title:'bad'})).toThrow();expect(()=>app.exams.remove(p,e.id)).toThrow();expect(()=>app.flashcards.removeDeck(p,d.id)).toThrow();expect(()=>app.flashcards.removeCard(p,card.id)).toThrow();}
 expect(app.search.query(me,'Task').some(x=>x.entityId===t.id)).toBe(true);app.tasks.remove(me,t.id);app.exams.remove(me,e.id);expect(app.search.query(me,'Task').some(x=>x.entityId===t.id)).toBe(false);expect(app.search.query(me,'Exam').some(x=>x.entityId===e.id)).toBe(false);app.flashcards.removeDeck(me,d.id);expect(app.tasks.get(me,t.id)).toBeNull();expect(app.exams.get(me,e.id)).toBeNull();expect(app.flashcards.card(me,card.id)).toBeNull();expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 }finally{db.close();}
});
it('Diary deletes exactly the selected day; active study records cannot be deleted',()=>{
 const {app,db}=setup(),me=user(app.me);try{app.diary.write(me,{day:'2026-10-12',body:'Old'});app.diary.write(me,{day:'2026-10-13',body:'Today'});expect(()=>app.diary.remove(user('other'),'2026-10-12')).toThrow();app.diary.remove(me,'2026-10-12');expect(app.diary.day(me,'2026-10-12')).toBeNull();expect(app.diary.day(me,'2026-10-13')?.body).toBe('Today');expect(()=>app.diary.write(me,{day:'2026-99-99',body:'bad'})).toThrow();const s=app.study.start(me,{goal:'Focus'});expect(()=>app.study.remove(me,s.id)).toThrow();app.study.end(me,s.id);app.study.update(me,s.id,{reflection:'Saved'});app.study.remove(me,s.id);expect(app.study.get(me,s.id)).toBeNull();}finally{db.close();}
});
it('collection removal moves items to Inbox and remote deletion has the same safe semantics',()=>{
 const {app,db}=setup(),me=user(app.me);try{const col=app.saved.createCollection(me,'Links'),item=app.saved.add(me,{url:'https://example.com',title:'Keep link',collectionId:col});expect(()=>app.saved.removeCollection(me,app.saved.inbox(me))).toThrow();app.saved.syncProviders()[0]!.apply(app.me,col,null,{merge:false});expect(app.saved.get(me,item.id)?.title).toBe('Keep link');app.saved.update(me,item.id,{title:'Updated'});app.saved.remove(me,item.id);expect(app.saved.get(me,item.id)).toBeNull();expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);}finally{db.close();}
});
it('sync child identity collisions cannot overwrite another task and roll back the aggregate',()=>{
 const {app,db}=setup(),me=user(app.me);try{const a=app.tasks.create(me,{title:'A',checklist:['A item']}),b=app.tasks.create(user('other'),{title:'B',checklist:['Private B']}),provider=app.tasks.syncProviders()[0]!,payload=provider.one(app.me,a.id) as Record<string,unknown>;payload['~tasks_checklist']=[{id:b.checklist[0]!.id,task_id:a.id,text:'Overwrite',done:0,position:0}];expect(()=>provider.apply(app.me,a.id,payload,{merge:false})).toThrow(/another record/);expect(app.tasks.get(user('other'),b.id)?.checklist[0]?.text).toBe('Private B');expect(app.tasks.get(me,a.id)?.checklist[0]?.text).toBe('A item');}finally{db.close();}
});

it('referenced files cannot be removed locally or by sync, and agents/revoked members cannot delete',async()=>{
 const {app,db,storageDir}=setup(),me=user(app.me);try{
 const f=await app.files.add(me,file(storageDir,'image.txt','original'),'image.txt',{kind:'personal',ownerId:app.me});
 const t=app.timetable.save(me,{name:'Photo schedule',timezone:'UTC',periods:[],imageId:f.refId});
 for(const remove of [()=>app.files.remove(me,f.refId),()=>app.files.syncProviders()[0]!.apply(app.me,f.refId,null,{merge:false})])expect(remove).toThrow(/still used/);
 expect(app.files.get(me,f.refId)).not.toBeNull();app.timetable.remove(me,t.id);
 expect(()=>app.files.remove({kind:'agent',agentId:'reader',onBehalfOf:app.me,scopes:['files:read']},f.refId)).toThrow();
 app.files.remove(me,f.refId);expect(app.files.get(me,f.refId)).toBeNull();
 const r=app.reminders.create(me,{text:'Original',dueAt:Date.now()+60000});expect(()=>app.reminders.remove({kind:'agent',agentId:'reader',onBehalfOf:app.me,scopes:['reminders:read']},r.id)).toThrow();app.reminders.update(me,r.id,{text:'Edited'});expect(app.reminders.get(me,r.id)?.text).toBe('Edited');
 }finally{db.close();}
});

it('lecture removal retains course references; board archive/restore/delete preserve independent Notes',()=>{
 const {app,db}=setup(),me=user(app.me);try{const c=app.courses.create(me,{name:'Course'}),t=app.courses.addTopic(me,c.id,'Topic'),l=app.courses.addLecture(me,c.id,{title:'Lecture',topicIds:[t.id]}),n=app.notes.create(me,{title:'Keep',body:'Original'});app.courses.link(me,c.id,{module:'notes',entityId:n.id,lectureId:l.id});expect(()=>app.courses.removeLecture(user('other'),l.id)).toThrow();app.courses.removeLecture(me,l.id);expect(app.courses.links(me,c.id)[0]?.lectureId).toBeNull();expect(app.courses.topics(me,c.id)).toHaveLength(1);
 const b=app.whiteboard.create(me,{kind:'personal',id:app.me},'Board');app.whiteboard.remove(me,b.id);expect(app.whiteboard.list(me,{kind:'personal',id:app.me},true)).toHaveLength(1);app.whiteboard.restore(me,b.id);expect(()=>app.whiteboard.discard(user('other'),b.id)).toThrow();app.whiteboard.discard(me,b.id);expect(app.whiteboard.get(me,b.id)).toBeNull();expect(app.whiteboard.syncProviders()[0]!.one(app.me,b.id)).toBeNull();expect(app.notes.get(me,n.id)?.body).toBe('Original');expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);}finally{db.close();}
});

it('recording references protect library files; active tapes/read agents cannot delete and foreign attachments are refused',async()=>{
 const {app,db,storageDir}=setup(),me=user(app.me),agent={kind:'agent' as const,agentId:'reader',onBehalfOf:app.me,scopes:['recordings:read']};try{const f=await app.files.add(me,file(storageDir,'frame.png','fixture'),'frame.png',{kind:'personal',ownerId:app.me},'image/png'),t=app.recordings.start(me,{title:'Fixture',source:'screen',partPath:storageDir+'/disposable.part'}),event=app.recordings.mark(me,t.id,{kind:'screenshot',atMs:0,refId:f.refId});expect(()=>app.files.remove(me,f.refId)).toThrow(/still used/);expect(()=>app.recordings.remove(agent,t.id)).toThrow();expect(()=>app.recordings.removeEvent(agent,event.id)).toThrow();expect(()=>app.recordings.remove(me,t.id)).toThrow(/Stop/);app.recordings.fail(me,t.id,'Disposable fixture');app.recordings.remove(me,t.id);app.files.remove(me,f.refId);
 const task=app.tasks.create(me,{title:'Task'}),foreign=app.notes.create(user('other'),{title:'Private',body:'Keep'});expect(()=>app.tasks.attach(me,task.id,'notes',foreign.id)).toThrow(/not allowed/);
 }finally{db.close();}
});

it('removed card text and tape timelines disappear from personal search',()=>{
 const {app,db,storageDir}=setup(),me=user(app.me);try{
 const deck=app.flashcards.createDeck(me,{name:'Deck'}),card=app.flashcards.addCard(me,deck.id,{front:'Privatecardword',back:'Answer'});
 expect(app.search.query(me,'Privatecardword').some(h=>h.module==='flashcards'&&h.entityId===deck.id)).toBe(true);
 app.flashcards.removeCard(me,card.id);expect(app.search.query(me,'Privatecardword')).toEqual([]);
 const tape=app.recordings.start(me,{title:'Privatetapeword',source:'screen',partPath:storageDir+'/disposable.part'});
 app.recordings.mark(me,tape.id,{kind:'note',atMs:0,text:'Privatetimelineword'});app.recordings.fail(me,tape.id,'Disposable fixture');
 expect(app.search.query(me,'Privatetimelineword').some(h=>h.module==='recordings')).toBe(true);
 app.recordings.remove(me,tape.id);expect(app.search.query(me,'Privatetimelineword')).toEqual([]);expect(app.search.query(me,'Privatetapeword')).toEqual([]);
 }finally{db.close();}
});
