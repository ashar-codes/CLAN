#!/usr/bin/env python3
"""Phone startup on the emulator for the installed build: N fresh-profile launches (`pm clear` first: new keys, new
encrypted database) then N launches on the existing profile. Records `am start -W` TotalTime (first activity drawn) and
time until the first screen's content is on screen ("Your details" when fresh, Home's "Join a CLAN" otherwise) (content ready: first raw screen capture equal to the settled screen; resolution = frameGapMs).
Usage: python3 apps/mobile/e2e/startup_bench.py <label> [n=3]"""
import hashlib, json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from android_cross_device import ADB, PKG, adb, find, tap, type_

def has(label):
    try: return bool(find(label, tries=1, scroll=False))
    except AssertionError: return False

def launch(fresh):
    adb('shell', 'am', 'force-stop', PKG)
    if fresh: adb('shell', 'pm', 'clear', PKG); adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS')
    time.sleep(2); t0 = time.monotonic(); seen = []
    proc = subprocess.Popen([ADB, 'shell', 'am', 'start', '-W', '-n', f'{PKG}/.MainActivity'], stdout=subprocess.PIPE, text=True)
    while time.monotonic() - t0 < 12:  # raw frames, hashed below the status bar: the first frame equal to the settled screen
        seen.append((time.monotonic() - t0, hashlib.sha1(adb('exec-out', 'screencap')[16 + 1080 * 4 * 160:]).digest()))
    out = proc.communicate(timeout=60)[0]
    ready = 'Your details' if fresh else 'Join a CLAN'  # a fresh profile opens on onboarding
    if not has(ready): raise AssertionError(f'{ready} not shown')
    final = seen[-1][1]; i = len(seen) - 1
    while i > 0 and seen[i - 1][1] == final: i -= 1
    return {'fresh': fresh, 'activityMs': int(re.search(r'TotalTime: (\d+)', out)[1]), 'contentReadyMs': round(seen[i][0] * 1000), 'frameGapMs': round(1000 * 12 / len(seen))}

def main():
    label, n = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 3
    runs = [launch(True) for _ in range(n)]
    type_('Full name', 'Sara Ahmed'); type_('Student / roll number', 'FA23-CS-007'); type_('Device name', 'Sara-Pixel'); tap('Save'); find('Join a CLAN')
    runs += [launch(False) for _ in range(n)]
    for r in runs: print(json.dumps(r), flush=True)
    os.makedirs('design/beta', exist_ok=True)
    json.dump({'label': label, 'emulator': 'Android 16 arm64 (Pixel profile), release build', 'runs': runs}, open(f'design/beta/startup-{label}.json', 'w'), indent=2)

if __name__ == '__main__': main()
