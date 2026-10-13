import {acquireMedia,releaseMedia} from './media-focus.ts';
// Common media lifecycle; platform adapters supply their installed LiveKit Room and pinned control API.
export type MeetingMedia = {
  connect(url:string,token:string,o:unknown):Promise<void>; disconnect():Promise<void>;
  localParticipant:{setMicrophoneEnabled(on:boolean):Promise<unknown>;setCameraEnabled(on:boolean):Promise<unknown>};
};
export class MeetingRoom {
  private generation=0; private cameraGeneration=0; private active=false; private closed=false;
  private room:MeetingMedia; private credential:()=>Promise<{token:string}>; private url:string; private cameraAllowed:()=>boolean;
  constructor(room:MeetingMedia,url:string,credential:()=>Promise<{token:string}>,cameraAllowed:()=>boolean=()=>true){this.room=room;this.url=url;this.credential=credential;this.cameraAllowed=cameraAllowed;}
  async join(video=false){if(this.closed)return;const gen=++this.generation;try{
    acquireMedia(this);const c=await this.credential();if(gen!==this.generation)return;
    await this.room.connect(this.url,c.token,{autoSubscribe:true,rtcConfig:{iceServers:[]}});
    if(gen!==this.generation){await this.room.disconnect();return;}
    this.active=true;await this.room.localParticipant.setMicrophoneEnabled(true);
    if(gen!==this.generation){await this.room.disconnect();return;}
    if(video)await this.camera(true);
    if(gen!==this.generation)await this.room.disconnect();
  }catch(e){await this.leave();throw e;}}
  async camera(on:boolean){const gen=this.generation,cam=++this.cameraGeneration;if(!this.active)return;if(on && !this.cameraAllowed())throw Error('Return to CLAN before enabling the camera.');await this.room.localParticipant.setCameraEnabled(on);if(gen!==this.generation)await this.room.disconnect();else if(on && (cam!==this.cameraGeneration || !this.cameraAllowed()))await this.room.localParticipant.setCameraEnabled(false);}
  async microphone(on:boolean){const gen=this.generation;if(!this.active)return;await this.room.localParticipant.setMicrophoneEnabled(on);if(gen!==this.generation)await this.room.disconnect();}
  async leave(){this.closed=true;this.generation++;this.active=false;try{await this.room.disconnect();}finally{releaseMedia(this);}}
}
