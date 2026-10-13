import type { Room, RoomConnectOptions } from 'livekit-client';
import type { MeetingMedia } from '@classroom/client';

/** Native camera IDs are opaque, not the browser placeholder "default". Keep the selected ID across mute/restart. */
export function nativeMeetingMedia(room: Pick<Room,'connect'|'disconnect'|'localParticipant'|'switchActiveDevice'>, devices: unknown, audio?: {start():Promise<void>;stop():Promise<void>}) {
  const cameras=(Array.isArray(devices)?devices:[]).filter((d):d is {kind:string;deviceId:string;facing?:string}=>d?.kind==='videoinput' && typeof d.deviceId==='string' && d.deviceId!=='' && d.deviceId!=='default');
  let selected=cameras.find(d=>d.facing==='front') ?? cameras[0];
  let started=false,pendingAudio:Promise<void>|null=null;
  const media:MeetingMedia={connect:(url,token,options)=>room.connect(url,token,options as RoomConnectOptions),disconnect:async()=>{try{await room.disconnect();}finally{await pendingAudio?.catch(()=>{});if(started){started=false;await audio?.stop();}}},localParticipant:{
    setMicrophoneEnabled:async on=>{if(on && audio && !started){started=true;pendingAudio=audio.start();await pendingAudio;}return room.localParticipant.setMicrophoneEnabled(on);},
    setCameraEnabled:on=>{if(on && !selected)return Promise.reject(Error('No native camera is available.'));return room.localParticipant.setCameraEnabled(on,selected?{deviceId:selected.deviceId,facingMode:selected.facing==='environment'?'environment':'user'}:undefined);},
  }};
  return {media,canSwitch:cameras.length>1,switchCamera:async()=>{
    if(cameras.length<2)throw Error('A second camera is unavailable.');
    const next=cameras[(cameras.indexOf(selected!)+1)%cameras.length]!;
    if(!await room.switchActiveDevice('videoinput',next.deviceId))throw Error('Camera switching failed.');
    selected=next;
  }};
}
