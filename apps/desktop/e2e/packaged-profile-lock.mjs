// Real packaged-app regression: duplicate writers refused; separate profiles remain independent.
// Node 24: node apps/desktop/e2e/packaged-profile-lock.mjs '/path/CLAN TEST.app/Contents/MacOS/CLAN TEST'
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const binary=process.argv[2]; assert(binary,'A real packaged executable is required');
const profiles=[mkdtempSync(tmpdir()+'/clan-lock-a-'),mkdtempSync(tmpdir()+'/clan-lock-b-')];
const children=[], browsers=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function launch(dir, extra=[]){const p=await port();const log=openSync(tmpdir()+'/clan-profile-lock-smoke.log','a');const child=spawn(binary,[`--remote-debugging-port=${p}`,'--remote-debugging-address=127.0.0.1',...extra],{env:{...process.env,CLASSROOM_USER_DATA:dir},stdio:['ignore',log,log]});children.push(child);return {child,p};}
async function page(proc){let b;for(let i=0;i<60;i++){assert.equal(proc.child.exitCode,null,'App exited before startup');try{b=await chromium.connectOverCDP(`http://127.0.0.1:${proc.p}`,{timeout:1500});break;}catch{await delay(500);}}assert(b,'Packaged CDP unavailable');browsers.push(b);const ctx=b.contexts()[0];const p=ctx.pages()[0]??await ctx.waitForEvent('page',{timeout:90000});await p.waitForLoadState('domcontentloaded');const caps=await p.evaluate(()=>window.classroom.capabilities());assert(caps.keystore.secure&&!caps.keystore.insecureDev);return p;}
try{
 const first=await launch(profiles[0]);const a=await page(first);const before=await a.evaluate(()=>window.classroom.getProfile());
 const duplicate=await launch(profiles[0],['clan://capture?text=ProfileLockIntake']);for(let i=0;i<40&&duplicate.child.exitCode===null;i++)await delay(250);
 assert.equal(duplicate.child.exitCode,0,'Same-profile second writer must quit cleanly');assert.equal(first.child.exitCode,null);
 await a.waitForFunction(async()=>JSON.stringify(await window.classroom.capture.inbox()).includes('ProfileLockIntake'),{},{timeout:10000});
 const after=await a.evaluate(()=>window.classroom.getProfile());assert.equal(after.devicePublicKey,before.devicePublicKey,'Identity changed after duplicate launch');
 const other=await launch(profiles[1]);const b=await page(other);const distinct=await b.evaluate(()=>window.classroom.getProfile());assert.notEqual(distinct.devicePublicKey,before.devicePublicKey,'Different profiles share an identity');
 console.log('PASS duplicate profile refused, capture link forwarded, primary identity preserved, separate profile works');
}finally{
 await Promise.all(browsers.map(b=>b.close().catch(()=>{})));
 for(const c of children)if(c.exitCode===null)c.kill('SIGTERM');
 await delay(1500);for(const c of children)if(c.exitCode===null)c.kill('SIGKILL');
 // Disposable evidence profiles stay in the system temp directory; production profiles are never touched.
}
