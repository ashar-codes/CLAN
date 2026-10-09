#!/usr/bin/env python3
"""Native Android release benchmark. Uses the unchanged protocol via the test peer.
Measures Android gfxinfo (host UI frames, not a GPU-only WebView FPS claim), PSS and cold activity startup.
Run after release installation; resets the emulator app's disposable test profile.
"""
import json, os, subprocess, time, re
from android_cross_device import adb, nodes, center, find, tap, type_, http, until, PKG, HOST_IP
OUT = os.path.abspath('design/astra/android-native')
os.makedirs(OUT, exist_ok=True)
def screenshot(name):
    with open(os.path.join(OUT, name+'.png'),'wb') as f: f.write(adb('exec-out','screencap','-p'))
def measure(count):
    print(f'Measuring after adding {count} strokes', flush=True)
    if count: http(47499, '/strokes', {'count': count})
    time.sleep(4)
    tap('Pen')
    x,y = find('board-canvas', scroll=False)
    adb('shell','dumpsys','gfxinfo',PKG,'reset')
    for i in range(30): adb('shell','input','swipe',str(x-120),str(y-80+i%4*30),str(x+120),str(y+50+i%4*30),'240')
    raw = adb('shell','dumpsys','gfxinfo',PKG,'framestats').decode()
    mem = adb('shell','dumpsys','meminfo',PKG).decode()
    frames=[]; cols=None
    for line in raw.splitlines():
        if line.startswith('Flags,'): cols=line.split(',')
        elif cols and re.match(r'^0,\d',line):
            v=line.split(',')
            try:
                dt=(int(v[cols.index('FrameCompleted')])-int(v[cols.index('IntendedVsync')]))/1e6
                if 0 < dt < 10000: frames.append(dt)
            except (IndexError,ValueError): pass
    frames.sort()
    key=str(count)
    open(os.path.join(OUT,'gfxinfo-'+key+'.txt'),'w').write(raw)
    open(os.path.join(OUT,'memory-'+key+'.txt'),'w').write(mem)
    # WebView renderers are separate Android processes; package PSS alone is incomplete.
    # Keep all sandbox process snapshots in this otherwise isolated test emulator.
    for line in adb('shell','ps','-A').decode().splitlines():
        if 'webview:sandboxed_process' in line:
            pid = line.split()[1]
            open(os.path.join(OUT, f'webview-{key}-{pid}.txt'), 'w').write(adb('shell','dumpsys','meminfo',pid).decode())
    screenshot('whiteboard-'+key)
    return {'addedStrokes':count,'hostObjects':len(http(47499,'/state')['board']), 'sampleFrames':len(frames),'p50Ms':frames[len(frames)//2] if frames else None,'p90Ms':frames[int(len(frames)*.9)] if frames else None, 'androidSummary':[s.strip() for s in raw.splitlines() if any(k in s for k in ['Janky frames:','50th percentile:','90th percentile:'])], 'pssSummary':[s.strip() for s in mem.splitlines() if 'TOTAL PSS:' in s or 'TOTAL RSS:' in s]}
peer = subprocess.Popen(['node','tools/sim/class-peer.ts','--host',HOST_IP],stdout=subprocess.PIPE,text=True)
try:
    peer.stdout.readline(); state=http(47499,'/state')
    adb('shell','pm','clear',PKG)
    cold=adb('shell','am','start','-W','-n',PKG+'/.MainActivity').decode(); time.sleep(4)
    type_('Full name','Astra Test'); type_('Student / roll number','ASTRA-12'); type_('Device name','Astra-Pixel'); tap('Save')
    find('Join a CLAN')
    screenshot('my-space')
    tap('Join a CLAN');
    # Same manual bootstrap entry as the cross-device test.
    type_('Six digit classroom code',state['code'])
    type_('Host address',state['bootstrap'])
    tap('Join')
    for _ in range(3):
        for n in nodes():
            if n.get('text') in ['Allow', 'Don’t allow', "Don't allow"]:
                x,y=center(n); adb('shell','input','tap',str(x),str(y)); time.sleep(1); break
    until(lambda: any(m['status']=='approved' for m in http(47499,'/state')['members']),'approval')
    time.sleep(3); http(47499,'/wall',{})
    find('board-canvas'); screenshot('clan-room')
    rows=[measure(80),measure(920),measure(4000)]
    open(os.path.join(OUT,'performance.json'),'w').write(json.dumps({'platform':'Android emulator, not physical hardware','coldActivity':cold,'rows':rows},indent=2))
    print(json.dumps(rows,indent=2),flush=True)
finally:
    peer.terminate(); peer.wait(timeout=20)
