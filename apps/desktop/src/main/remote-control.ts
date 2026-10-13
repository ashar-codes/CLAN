import {app,BrowserWindow,dialog,ipcMain,screen} from 'electron';
import {spawn,execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import {ControlInput,type ControlView} from '@classroom/protocol';
import {controlDisplay} from './screen.ts';
type Conn={url:string;token:string;sessionId:string};
const binary=()=>join(app.isPackaged?join(process.resourcesPath,'remote-control'):join(app.getAppPath(),'../..','native/remote-control/bin',`${process.platform}-${process.arch}`),process.platform==='win32'?'clan-control.exe':'clan-control');
export function registerRemoteControl(request:(c:unknown,path:unknown,body?:unknown)=>Promise<unknown>){
 let stop:(()=>void)|null=null;
 const available=async(prompt=false)=>{if(!['darwin','win32'].includes(process.platform)||!existsSync(binary()))return false;try{const {stdout}=await promisify(execFile)(binary(),[prompt?'--request':'--check'],{timeout:5000,maxBuffer:4096});return JSON.parse(stdout).available===true;}catch{return false;}};
 ipcMain.handle('control:capability',async()=>({available:await available(),platform:process.platform,reason:'Control requires a whole shared display, Accessibility/Input Monitoring on macOS, and an unelevated desktop. Local input stops control.'}));
 ipcMain.handle('control:permission',()=>available(true));
 ipcMain.handle('control:stop',()=>{stop?.();});app.on('before-quit',()=>stop?.());
 ipcMain.handle('control:approve',async(e,c:Conn,room:unknown,id:unknown)=>{
  const path='/api/control/'+z.string().regex(/^m-[a-f0-9-]{36}$/).parse(room),requestId=z.uuid().parse(id);
  const view=await request(c,path) as ControlView,r=view.requests.find(r=>r.id===requestId && r.target===view.me);if(!r)throw Error('Control request expired.');
  const display=controlDisplay(String(room),r.screen,e.sender.id);if(!display)throw Error('Remote control supports a selected whole display only. Share a screen first.');if(!await available())throw Error('Native control permissions or helper unavailable. Enable permissions locally first.');
  const win=BrowserWindow.fromWebContents(e.sender);if(!win)throw Error('Sharing window unavailable.');
  const answer=await dialog.showMessageBox(win,{type:'warning',buttons:['Reject','Allow for 3 minutes'],defaultId:0,cancelId:0,title:'Allow remote control?',message:`${r.controller.name} requests control`,detail:`Verified device: ${r.controller.fingerprint ?? r.controller.identity}\nThey can click, drag, scroll and type on this shared display. The CLAN host can access input. No clipboard, files or system shortcuts. Your local mouse/keyboard activity immediately stops control.`});
  if(answer.response!==1){await request(c,path,{action:'reject',request:requestId});return;}stop?.();
  const approved=await request(c,path,{action:'approve',request:requestId}) as ControlView,g=approved.grant;if(!g || g.target!==view.me || g.controller.identity!==r.controller.identity)throw Error('Control grant changed.');
  const child=spawn(binary(),[],{stdio:['pipe','pipe','ignore'],windowsHide:true});let alive=true,timer:NodeJS.Timeout|undefined,output='';
  const write=(v:unknown)=>{if(alive && child.stdin.writable)child.stdin.write(JSON.stringify(v)+'\n');};
  const halt=()=>{if(!alive)return;write({kind:'stop'});alive=false;clearTimeout(timer);win.removeListener('closed',halt);child.stdin.end();const termination=setTimeout(()=>child.kill(),250);termination.unref();child.once('exit',()=>clearTimeout(termination));void request(c,path,{action:'revoke',grant:g.id}).catch(()=>{});if(stop===halt)stop=null;};stop=halt;
  child.on('error',halt).on('exit',halt);win.once('closed',halt);
  child.stdout.on('data',chunk=>{output+=String(chunk);if(output.length>8192){halt();return;}const lines=output.split('\n');output=lines.pop()!;for(const line of lines)if(line){try{const v=JSON.parse(line);if(v.stopped||v.error)halt();}catch{halt();}}});
  const monitor=screen.getAllDisplays().find(s=>String(s.id)===display);if(!monitor){halt();throw Error('Shared display disconnected.');}
  write({kind:'arm',display:process.platform==='darwin'?Number(display):display,bounds:process.platform==='win32'?screen.dipToScreenRect(null,monitor.bounds):monitor.bounds,seconds:Math.min(180,Math.max(1,(g.expiresAt-Date.now())/1000))});
  const poll=async()=>{try{const state=await Promise.race([request(c,path,{action:'pull'}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Control heartbeat lost')),900);t.unref();})]) as ControlView;if(!alive)return;if(state.grant?.id!==g.id||controlDisplay(String(room),g.screen,e.sender.id)!==display||Date.now()>=g.expiresAt){halt();return;}write({kind:'heartbeat'});for(const p of state.inputs)write({kind:'input',input:ControlInput.parse(p.input)});timer=setTimeout(()=>void poll(),50);}catch{halt();}};void poll();
 });
}
