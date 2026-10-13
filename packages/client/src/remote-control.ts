/** Coordinates refer to the shared content, not letterbox bars; reject input outside the image. */
export function controlPoint(x:number,y:number,view:{width:number;height:number},image:{width:number;height:number}){if(![x,y,view.width,view.height,image.width,image.height].every(Number.isFinite)||view.width<=0||view.height<=0||image.width<=0||image.height<=0)return null;const scale=Math.min(view.width/image.width,view.height/image.height),w=image.width*scale,h=image.height*scale,dx=(view.width-w)/2,dy=(view.height-h)/2;if(x<dx||y<dy||x>dx+w||y>dy+h)return null;return {x:(x-dx)/w,y:(y-dy)/h};}
/** Ordered input; moves coalesce, button-up never drops. Ambiguous delivery stops the grant, never retries input. */
export class ControlSender {
 private queue:import('@classroom/protocol').ControlInput[]=[];private running=false;private closed=false;private seq=0;
 private send:(seq:number,input:import('@classroom/protocol').ControlInput)=>Promise<unknown>;private failed:()=>void;
 constructor(send:(seq:number,input:import('@classroom/protocol').ControlInput)=>Promise<unknown>,failed:()=>void){this.send=send;this.failed=failed;}
 push(input:import('@classroom/protocol').ControlInput){if(this.closed)return;const last=this.queue.at(-1);if(input.type==='pointer'&&input.action==='move'&&last?.type==='pointer'&&last.action==='move')this.queue[this.queue.length-1]=input;else{if(this.queue.length>=16){this.close();this.failed();return;}this.queue.push(input);}if(!this.running)void this.flush();}
 private async flush(){this.running=true;try{while(!this.closed&&this.queue.length){await this.send(++this.seq,this.queue.shift()!);await new Promise(r=>setTimeout(r,35));}}catch{this.close();this.failed();}finally{this.running=false;}}
 close(){this.closed=true;this.queue=[];}
}

/** A control grant must refer to the exact local capture, not whichever monitor was most recently picked. */
export class ControlCapture {
 private current:{ticket:string;room:string|null;display:string|null;owner:number;screen:string|null}|null=null;
 picked(ticket:string,room:string|null,display:string|null,owner:number){this.current={ticket,room,display,owner,screen:null};}
 bind(ticket:string,room:string,screen:string,owner:number){const c=this.current;if(!c||c.ticket!==ticket||c.room!==room||c.owner!==owner)throw Error('This meeting does not own the selected whole-display capture.');c.screen=screen;}
 display(room:string,screen:string,owner:number){const c=this.current;return c?.room===room&&c.screen===screen&&c.owner===owner?c.display:null;}
}
