import { describe, expect, it, vi } from 'vitest';
import { MeetingRoom, type MeetingMedia } from '../src/meeting-room.ts';
function deferred<T>() { let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }
function fixture() {
 const media:MeetingMedia={connect:vi.fn(async()=>{}),disconnect:vi.fn(async()=>{}),localParticipant:{setMicrophoneEnabled:vi.fn(async()=>{}),setCameraEnabled:vi.fn(async()=>{})}};
 return {media,ctl:new MeetingRoom(media,'wss://verified-host/media',async()=>({token:'scoped'}))};
}
describe('meeting capture lifecycle',()=>{
 it('turns off late camera capture after backgrounding or an explicit camera-off request',async()=>{
  const {media}=fixture();let foreground=true;
  const ctl=new MeetingRoom(media,'wss://host/media',async()=>({token:'scoped'}),()=>foreground);await ctl.join();
  const capture=deferred<void>();media.localParticipant.setCameraEnabled=vi.fn(on=>on?capture.promise:Promise.resolve());
  const pending=ctl.camera(true);foreground=false;capture.resolve();await pending;
  expect(media.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(false);
  await expect(ctl.camera(true)).rejects.toThrow('Return to CLAN');foreground=true;
  const late=deferred<void>();media.localParticipant.setCameraEnabled=vi.fn(on=>on?late.promise:Promise.resolve());
  const enabling=ctl.camera(true);await ctl.camera(false);late.resolve();await enabling;
  expect(media.localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(false);await ctl.leave();
 });
 it('refuses simultaneous capture sessions and releases the lease on leave',async()=>{const a=fixture(),b=fixture();await a.ctl.join();await expect(b.ctl.join()).rejects.toThrow('Another call');expect(b.media.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();await a.ctl.leave();const c=fixture();await c.ctl.join();await c.ctl.leave();});
 it('does not connect or capture after a cancelled credential request',async()=>{
  const {media}=fixture(),credential=deferred<{token:string}>(),ctl=new MeetingRoom(media,'wss://host/media',()=>credential.promise);
  const joining=ctl.join(true);await ctl.leave();credential.resolve({token:'scoped'});await joining;
  expect(media.connect).not.toHaveBeenCalled();expect(media.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  await ctl.join(true);expect(media.connect).not.toHaveBeenCalled();
 });
 it('disconnects again when late microphone acquisition completes after leave',async()=>{
  const {media,ctl}=fixture(),mic=deferred<void>();media.localParticipant.setMicrophoneEnabled=vi.fn(()=>mic.promise);
  const joining=ctl.join(true);await vi.waitFor(()=>expect(media.localParticipant.setMicrophoneEnabled).toHaveBeenCalled());
  await ctl.leave();mic.resolve();await joining;
  expect(media.disconnect).toHaveBeenCalledTimes(2);expect(media.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
 });
 it('releases failed capture and late camera or microphone toggles',async()=>{
  const {media,ctl}=fixture();await ctl.join();const camera=deferred<void>();media.localParticipant.setCameraEnabled=vi.fn(()=>camera.promise);
  const pending=ctl.camera(true);await ctl.leave();camera.resolve();await pending;expect(media.disconnect).toHaveBeenCalledTimes(2);
  const f=fixture();f.media.localParticipant.setCameraEnabled=vi.fn(async()=>{throw Error('Permission denied');});
  await expect(f.ctl.join(true)).rejects.toThrow('Permission denied');expect(f.media.disconnect).toHaveBeenCalled();
 });
});
