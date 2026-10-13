import {expect,it,vi} from 'vitest';
import type {Room} from 'livekit-client';
import {nativeMeetingMedia} from '../src/media/native-camera';
it('uses native device IDs through camera restart and switching, never browser default',async()=>{
 const camera=vi.fn(async()=>undefined),switcher=vi.fn(async()=>true);
 const room={connect:vi.fn(),disconnect:vi.fn(),localParticipant:{setMicrophoneEnabled:vi.fn(),setCameraEnabled:camera},switchActiveDevice:switcher} as unknown as Room;
 const adapter=nativeMeetingMedia(room,[{kind:'videoinput',deviceId:'default'},{kind:'videoinput',deviceId:'0',facing:'environment'},{kind:'videoinput',deviceId:'1',facing:'front'}]);
 await adapter.media.localParticipant.setCameraEnabled(true);expect(camera).toHaveBeenLastCalledWith(true,{deviceId:'1',facingMode:'user'});
 await adapter.media.localParticipant.setCameraEnabled(false);await adapter.media.localParticipant.setCameraEnabled(true);expect(camera).toHaveBeenLastCalledWith(true,{deviceId:'1',facingMode:'user'});
 await adapter.switchCamera();expect(switcher).toHaveBeenCalledWith('videoinput','0');await adapter.media.localParticipant.setCameraEnabled(true);expect(camera).toHaveBeenLastCalledWith(true,{deviceId:'0',facingMode:'environment'});
 const absent=nativeMeetingMedia(room,[]);await expect(absent.media.localParticipant.setCameraEnabled(true)).rejects.toThrow('No native camera');expect(absent.canSwitch).toBe(false);
});
it('does not stop another call audio session and holds cleanup until its own pending start settles',async()=>{
 const room={connect:vi.fn(),disconnect:vi.fn(async()=>{}),localParticipant:{setMicrophoneEnabled:vi.fn(),setCameraEnabled:vi.fn()},switchActiveDevice:vi.fn()} as unknown as Room;
 let complete!:()=>void;const start=vi.fn(()=>new Promise<void>(r=>complete=r)),stop=vi.fn(async()=>{}),adapter=nativeMeetingMedia(room,[],{start,stop});
 await adapter.media.disconnect();expect(stop).not.toHaveBeenCalled();
 const microphone=adapter.media.localParticipant.setMicrophoneEnabled(true),leaving=adapter.media.disconnect();
 await Promise.resolve();expect(stop).not.toHaveBeenCalled();complete();await microphone;await leaving;expect(stop).toHaveBeenCalledOnce();
 await adapter.media.disconnect();expect(stop).toHaveBeenCalledOnce();
});
