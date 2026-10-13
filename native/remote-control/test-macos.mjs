// Disposable Mac native-input smoke. Never target the installed CLAN app or a personal profile.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../apps/desktop/package.json',import.meta.url));const {_electron:electron}=require('playwright-core');
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const app=await electron.launch({args:[fileURLToPath(new URL('./test-target.cjs',import.meta.url))],env:{...process.env}});let helper;
try{const page=await app.firstWindow();await page.locator('#field').waitFor();await page.locator('#field').focus();await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();w.webContents.focus();});
 helper=spawn(fileURLToPath(new URL('./bin/darwin-'+process.arch+'/clan-control',import.meta.url)),[],{stdio:['pipe','pipe','pipe']});let output='';helper.stderr.on('data',b=>process.stderr.write(b));helper.stdout.on('data',b=>output+=b);const send=v=>helper.stdin.write(JSON.stringify(v)+'\n');send({kind:'arm',display:1,pid:app.process().pid,seconds:15});for(let n=0;n<50&&!output.includes('\"armed\":true')&&!output.includes('stopped');n++)await delay(50);if(!output.includes('"armed":true'))throw Error('Native guard did not arm: '+output);
 const heartbeat=setInterval(()=>send({kind:'heartbeat'}),250);try{send({kind:'input',input:{type:'text',text:'CLAN native input QA'}});await delay(400);const text=await page.locator('#field').inputValue();if(text!=='CLAN native input QA')throw Error('Text integrity mismatch: '+JSON.stringify(text));send({kind:'stop'});send({kind:'input',input:{type:'text',text:'MUST NOT TYPE'}});await delay(300);if(await page.locator('#field').inputValue()!==text)throw Error('Input after revoke');console.log(JSON.stringify({textIntegrity:true,stopRejectsInput:true,target:'disposable Electron app',hardware:'Mac',permission:'actual OS guard'}));}finally{clearInterval(heartbeat);}
}finally{helper?.stdin.end();helper?.kill();await app.close();}
