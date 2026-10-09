// Short recording of real production actions. No animation triggers or synthetic state.
import { _electron as electron } from 'playwright-core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const out = join(import.meta.dirname,'../../../design/astra/captures'); mkdirSync(out,{recursive:true});
const app = await electron.launch({args:['.'],cwd:join(import.meta.dirname,'..'),recordVideo:{dir:out,size:{width:1440,height:900}},env:{...process.env,CLASSROOM_USER_DATA:mkdtempSync(join(tmpdir(),'clan-astra-motion-'))}});
const marks: object[]=[];const start=Date.now();
try {
 const p=await app.firstWindow(); await p.setViewportSize({width:1440,height:900}); await p.waitForLoadState();
 const mark=(action:string)=>marks.push({action,ms:Date.now()-start});
 await p.getByRole('button',{name:'Focus',exact:true}).waitFor();
 mark('Hover the functional desk');await p.getByRole('button',{name:/^Desk:/}).hover(); await p.waitForTimeout(1000);
 mark('Start Focus');await p.getByRole('button',{name:'Focus',exact:true}).click();await p.waitForTimeout(1000);
 mark('End Focus');await p.getByRole('button',{name:'End focus',exact:true}).click();await p.waitForTimeout(600);
 mark('Open Guide');await p.getByRole('button',{name:'CLAN Guide: contextual help'}).click();await p.getByTestId('ai-sheet').waitFor();await p.waitForTimeout(1200);await p.getByTestId('ai-sheet').getByRole('button',{name:'Close',exact:true}).click();
 mark('Begin a study session');await p.getByRole('button',{name:'Start studying',exact:true}).click();await p.getByTestId('session-bar').waitFor();await p.waitForTimeout(1500);
 writeFileSync(join(out,'motion-timeline.json'),JSON.stringify({platform:'Production Electron, macOS',marks},null,2));
 const video=p.video();await app.close();await video?.saveAs(join(out,'focus-guide-study.webm'));await video?.delete();
} finally { await app.close().catch(()=>{}); }
