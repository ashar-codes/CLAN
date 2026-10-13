#!/usr/bin/env python3
"""Native Android meeting fixture, disposable emulator only; Node publishers provide virtual media.
Requires scripts/android-qa.sh output installed, ADB selecting that emulator, SDK camera image available.
Runs real pairing, native pinned signaling, native WebRTC and checks decoded camera frames at the SFU.
"""
import hashlib, json, re, subprocess, time, urllib.request
import android_cross_device as ui

def state():
    with urllib.request.urlopen('http://127.0.0.1:47498/state', timeout=15) as r:
        return json.load(r)

def allow():
    for _ in range(5):
        ns = ui.nodes()
        p = next((n for n in ns if n.get('resource-id') in (
            'com.android.permissioncontroller:id/permission_allow_foreground_only_button',
            'com.android.permissioncontroller:id/permission_allow_button',
            'com.android.permissioncontroller:id/permission_allow_one_time_button')), None)
        if p is None: return
        x, y = ui.center(p); ui.adb('shell', 'input', 'tap', str(x), str(y)); time.sleep(1)

def main():
    assert ui.adb('shell','getprop','ro.kernel.qemu').strip()==b'1', 'Emulator only; never clear a physical profile'
    ui.adb('shell','am','start','-n',ui.ACTIVITY)
    proc=subprocess.Popen(['node','tools/sim/meeting-peer.ts'],stdout=subprocess.PIPE,text=True)
    try:
        while True:
            line=proc.stdout.readline()
            assert line, 'Fixture exited before ready'
            if 'fixture ready' in line: break
        s=state()
        if any('The CLAN has ended' in (n.get('text') or '') for n in ui.nodes()): ui.tap('OK')
        ui.tap('Home'); ui.tap('Join a CLAN'); ui.type_('Six digit classroom code',s['code']); ui.type_('Host address',s['bootstrap']); ui.tap('Join')
        ui.until(lambda:len(state()['state']['members'])>=3,'native member securely joined',secs=90)
        allow(); ui.tap('Join video'); allow()
        ui.until(lambda:len(state()['state']['meetings'][0]['joined'])==3,'three actual SFU participants',secs=60)
        ui.until(lambda:any(x['audioFrames']>10 and x['distinctVideoFrames']>3 for x in state()['received']),'native microphone frames and changing native camera frames decoded at SFU',secs=60)
        print('PASS native publish:',state()['received'],flush=True)
        ui.find('~QA Host'); ui.tap('Fullscreen video')
        surfaces=[n for n in ui.nodes() if n.get('class')=='android.view.SurfaceView']
        assert len(surfaces)==1, 'Fullscreen native remote video surface must be visible'
        left,top,right,bottom=map(int,re.findall(r'\d+',surfaces[0].get('bounds')))
        hashes=set()
        for _ in range(4):
            png=ui.adb('exec-out','screencap','-p')
            image=subprocess.run(['ffmpeg','-v','error','-i','pipe:0','-vf',f'crop={right-left}:{bottom-top}:{left}:{top}','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],input=png,capture_output=True,check=True).stdout
            assert image, 'Native remote video capture is empty'
            hashes.add(hashlib.sha256(image).hexdigest());time.sleep(.4)
        assert len(hashes)>=3, 'Native remote video must display changing frames'
        print('PASS native remote rendered frames:',len(hashes),flush=True)
        # This native modal has no fixed Home/Study tabs. Its bottom control is above Android's navigation bar;
        # the ordinary page helper reserves additional space for CLAN's tab bar and must not scroll this modal.
        x,y=ui.find('Close fullscreen',clickable=True);ui.adb('shell','input','tap',str(x),str(y));time.sleep(.7)
        ui.find('~3 participants'); ui.tap('Raise meeting hand'); ui.until(lambda:len(state()['state']['meetings'][0]['hands'])==1,'authorized raised hand')
        ui.tap('Mute microphone'); ui.find('Unmute microphone');ui.tap('Unmute microphone');ui.find('Mute microphone'); ui.tap('Camera off'); ui.find('Camera on');ui.tap('Camera on');ui.find('Camera off');ui.tap('Switch camera');ui.find('Camera off')
        ui.tap('Leave meeting'); ui.until(lambda:len(state()['state']['meetings'][0]['joined'])==2,'native leave releases participant')
        print('PASS native meeting controls and leave; simulated sources, not physical hardware',flush=True)
    except Exception:
        print('Screen at failure:', ' | '.join(n.get('text') or n.get('content-desc') for n in ui.nodes() if n.get('text') or n.get('content-desc')),flush=True)
        raise
    finally:
        proc.terminate()
        try: proc.wait(timeout=20)
        except subprocess.TimeoutExpired: proc.kill();proc.wait()
        assert proc.returncode==0, f'Native fixture cleanup failed: {proc.returncode}'

if __name__=='__main__': main()
