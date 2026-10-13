// Owner-only Diary. No private body previews outside this screen; sync remains explicit opt-in.
import {useState} from 'react';
import {phoneClan,me} from '../core/clan';
import {act,Btn,Card,DateField,Err,H1,Muted,Row,Screen,useData} from '../ui/kit';
import {Editor,confirmRemove} from '../ui/Editor';
const dayKey=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export function DiaryScreen(){
 const [day,setDay]=useState(()=>dayKey(new Date())),[editing,setEditing]=useState(false),[error,setError]=useState<string|null>(null);
 const entry=useData(()=>phoneClan().diary.day(me(),day)),recent=useData(()=>phoneClan().diary.recent(me(),200))??[],syncing=useData(()=>phoneClan().sync.settings().syncDiary)??false;
 return <Screen><H1>Diary</H1><DateField label="Entry date" time={false} value={new Date(day+'T12:00:00').getTime()} onChange={v=>{if(v!==null){setDay(dayKey(new Date(v)));setError(null);}}}/>
  <Card title={day} tone="burgundy"><Muted>{entry?'An entry is saved for this date.':'No entry for this date.'}</Muted><Row><Btn primary label={entry?'Edit entry':'Write entry'} onPress={()=>setEditing(true)}/>{entry&&<Btn danger label="Delete entry" onPress={()=>confirmRemove(`Diary ${day}`,syncing?'Deletes this date’s entry on this device and linked devices where Diary sync is enabled. Other dates remain.':'Deletes only this date’s local entry. Diary sync is off.',()=>phoneClan().diary.remove(me(),day),setError)}/>}<Btn label="Today" onPress={()=>setDay(dayKey(new Date()))}/></Row><Err msg={error}/><Muted small>{syncing?'Diary sync is enabled for your linked devices.':'Diary sync is off. Entries stay on this device.'}</Muted></Card>
  {editing&&<Editor key={day} title={`Diary ${day}`} initial={{body:entry?.body??'',mood:entry?.mood??''}} labels={{body:'Entry',mood:'Mood (optional: calm, happy, proud, tired, anxious, low)'}} multiline={['body']} read={()=>{const e=phoneClan().diary.day(me(),day);return {body:e?.body??'',mood:e?.mood??''};}} onSave={v=>{phoneClan().diary.write(me(),{day,body:v.body!,mood:(v.mood||null) as never});setError(act(()=>{}));}} onClose={()=>setEditing(false)}/>}
  <H1>Previous entries</H1>{recent.filter(e=>e.day!==day).map(e=><Btn key={e.id} label={e.day} a11y={`Open Diary ${e.day}`} onPress={()=>{setDay(e.day);setError(null);}}/>)}
 </Screen>;
}
