import {useEffect,useRef,useState} from 'react';
import {errText} from './useLoad.ts';
export type EditField={key:string;label:string;multiline?:boolean;type?:'text'|'datetime-local';required?:boolean};
/** Native modal focus management; drafts survive validation and IPC failures. */
export function ContentEditor({title,initial,fields,save,close}:{title:string;initial:Record<string,string>;fields:EditField[];save:(v:Record<string,string>)=>Promise<unknown>;close:()=>void}){
 const ref=useRef<HTMLDialogElement>(null),[v,setV]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{ref.current?.showModal();},[]);
 const cancel=()=>{if(!busy&&(JSON.stringify(v)===JSON.stringify(initial)||confirm(`Discard unsaved changes to “${title}”?`)))close();};
 return <dialog ref={ref} aria-label={title} onCancel={e=>{e.preventDefault();cancel();}} style={{width:'min(620px,90vw)',maxHeight:'85vh',padding:0}}><form className="stack" style={{padding:20,maxHeight:'80vh',overflowY:'auto'}} onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');try{await save(v);close();}catch(x){setError(errText(x));setBusy(false);}}}><h2>{title}</h2>{fields.map(f=><label className="stack" key={f.key}>{f.label}{f.multiline?<textarea aria-label={f.label} value={v[f.key]??''} required={f.required} onChange={e=>setV({...v,[f.key]:e.target.value})}/>:<input aria-label={f.label} type={f.type??'text'} value={v[f.key]??''} required={f.required} onChange={e=>setV({...v,[f.key]:e.target.value})}/>}</label>)}{error&&<p className="error" role="alert">{error}</p>}<div className="row" style={{position:'sticky',bottom:0,background:'var(--paper)',padding:8}}><button className="primary" disabled={busy}>{busy?'Saving…':'Save changes'}</button><button type="button" disabled={busy} onClick={cancel}>Cancel</button></div></form></dialog>;
}
