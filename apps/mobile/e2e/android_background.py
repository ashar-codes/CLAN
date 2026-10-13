#!/usr/bin/env python3
"""Disposable-emulator background acceptance through actual authenticated native TCP.
No profile clearing. The peer's synthetic SDP tests ringing only, never media transmission.
"""
import json, os, subprocess, time, urllib.request
import android_cross_device as ui

def api(path, body=None):
    request = urllib.request.Request('http://127.0.0.1:47598'+path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response: return json.load(response)

def allow():
    for _ in range(5):
        button = next((n for n in ui.nodes() if n.get('resource-id') in ('com.android.permissioncontroller:id/permission_allow_button','com.android.permissioncontroller:id/permission_allow_foreground_only_button')), None)
        if button is None: return
        x,y=ui.center(button); ui.adb('shell','input','tap',str(x),str(y)); time.sleep(.5)

def deliver(label):
    started=time.monotonic(); message=api('/message',{'text':label})
    ui.until(lambda: any(m['id']==message['id'] and m['state']=='delivered' for m in api('/state')['messages']), label+' recipient receipt',secs=30)
    assert sum(m['id']==message['id'] for m in api('/state')['messages'])==1
    print('PASS',label,'authenticated recipient receipt',round(time.monotonic()-started,2),'s',flush=True)

def main():
    assert ui.adb('shell','getprop','ro.kernel.qemu').strip()==b'1', 'Disposable emulator only'
    ui.adb('shell','settings','put','global','transition_animation_scale','0');
    ui.adb('shell','input','keyevent','KEYCODE_WAKEUP'); ui.adb('shell','wm','dismiss-keyguard')
    ui.adb('shell','am','start','-n',ui.ACTIVITY); time.sleep(3)
    ui.tap('People')
    for _ in range(12): ui.adb('shell','input','swipe','100','600','100','1500','150')
    ui.tap('Nearby')
    x,y=ui.find('CLAN profile code',edit=True); ui.adb('shell','input','tap',str(x),str(y))
    ui.adb('shell','input','keycombination','KEYCODE_CTRL_LEFT','KEYCODE_A'); ui.adb('shell','input','keyevent','KEYCODE_DEL')
    code=api('/state')['qr']; ui.type_('CLAN profile code',code)
    assert any(n.get('content-desc')=='CLAN profile code' and n.get('text')==code for n in ui.nodes()), 'exact authenticated code entry'
    print('PASS exact profile code entry',flush=True); ui.tap('Connect using profile code')
    ui.find('Connected to BTC-2R QA Mac. Their identity matched the code.'); ui.tap('Send friend request')
    ui.until(lambda:api('/state')['requests']>0,'signed friend request',secs=30); api('/approve',{})
    ui.until(lambda:api('/state')['friends']==1,'authorized friendship')
    api('/invite',{}); ui.tap('Chats'); ui.tap('Open chat with BTC-2R QA Mac'); ui.tap('Accept')
    ui.until(lambda:any(c['state']=='active' for c in api('/state')['conversations']),'accepted chat')
    deliver('BTC2R foreground')
    ui.tap('← Chats'); ui.tap('Nearby'); ui.tap('Keep CLAN Available'); allow()
    # Permission prompts can interrupt the first action; the user must explicitly select again.
    if 'PeerLinkService' not in ui.adb('shell','dumpsys','activity','services',ui.PKG).decode(): ui.tap('Keep CLAN Available'); allow()
    ui.until(lambda:'isForeground=true' in ui.adb('shell','dumpsys','activity','services',ui.PKG).decode(),'foreground service',secs=20)
    ui.adb('shell','input','keyevent','KEYCODE_HOME'); time.sleep(2)
    deliver('BTC2R UI closed')
    ui.adb('shell','input','keyevent','KEYCODE_SLEEP'); time.sleep(2)
    deliver('BTC2R screen asleep')
    call=api('/call',{}); assert call['sent'] is True
    ui.until(lambda:ui.PKG in ui.adb('shell','dumpsys','notification').decode() and 'Incoming CLAN call' in ui.adb('shell','dumpsys','notification','--noredact').decode(),'native incoming-call notification',secs=15)
    print('PASS authenticated invitation notification while screen asleep; media NOT TESTED',flush=True)
    api('/disconnect',{}); ui.until(lambda:api('/state')['connected'],'idle friend reconnect without UI',secs=30)
    deliver('BTC2R after idle reconnect')
    ui.adb('shell','cmd','connectivity','airplane-mode','enable'); time.sleep(4)
    queued=api('/message',{'text':'BTC2R queued across network loss'})
    time.sleep(2); assert not any(m['id']==queued['id'] and m['state']=='delivered' for m in api('/state')['messages'])
    ui.adb('shell','cmd','connectivity','airplane-mode','disable')
    ui.until(lambda:any(m['id']==queued['id'] and m['state']=='delivered' for m in api('/state')['messages']),'background network-return receipt',secs=45)
    print('PASS background network return and queued delivery',flush=True)
    ui.adb('shell','am','force-stop',ui.PKG); time.sleep(2)
    ui.until(lambda:not api('/state')['connected'],'force-stop unavailable',secs=15)
    assert 'PeerLinkService' not in ui.adb('shell','dumpsys','activity','services',ui.PKG).decode()
    print('PASS force-stop stops availability',flush=True)

if __name__=='__main__':
    try: main()
    finally:
        ui.adb('shell','cmd','connectivity','airplane-mode','disable')
        ui.adb('shell','settings','put','global','transition_animation_scale','1.0')
        ui.adb('shell','input','keyevent','KEYCODE_WAKEUP'); ui.adb('shell','wm','dismiss-keyguard')
