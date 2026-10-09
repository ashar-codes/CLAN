#!/usr/bin/env python3
"""Phone whiteboard benchmark on the Android emulator: the same workload for whichever renderer the installed build uses
(canvas = normal build; legacy views = EXPO_PUBLIC_BOARD_RENDERER=views). A headless CLAN host (tools/sim/class-peer.ts)
puts the board on the wall, adds strokes in stages, and at each stage the phone draws the same 30 swipes.
Per stage: frame p50/p90/p99 and janky % from `gfxinfo` (reset before the swipes), app PSS and WebView renderer PSS.
Usage: python3 apps/mobile/e2e/android_board_bench.py <label> [stages...]   (default stages: 100 1000 5000 total strokes)
Emulator numbers: relative comparison only; not physical-phone performance."""
import json, os, re, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from android_cross_device import ADB, PKG, HOST_IP, adb, find, http, tap, type_, until

def pss(proc_filter):
    out = adb('shell', 'dumpsys', 'meminfo').decode('utf8', 'ignore').split('Total PSS by process:')[1].split('Total PSS by OOM')[0]
    return round(sum(int(m.group(1).replace(',', '')) for m in re.finditer(r'^\s*([\d,]+)K: (\S+)', out, re.M) if proc_filter(m.group(2))) / 1024, 1)
def frames():
    out = adb('shell', 'dumpsys', 'gfxinfo', PKG).decode('utf8', 'ignore')
    g = lambda k: (re.search(k + r':\s*([\d.]+)', out) or [None, 'nan'])[1]
    jank = re.search(r'Janky frames: (\d+) \(([\d.]+)%\)', out)
    return {'frames': int(g('Total frames rendered')), 'p50': float(g('50th percentile')), 'p90': float(g('90th percentile')), 'p99': float(g('99th percentile')), 'jankyPct': float(jank[2]) if jank else None}

def main():
    label, stages = sys.argv[1], [int(x) for x in sys.argv[2:]] or [100, 1000, 5000]
    host = subprocess.Popen(['node', 'tools/sim/class-peer.ts', '--host', HOST_IP], stdout=subprocess.PIPE, text=True)
    try:
        host.stdout.readline(); cls = http(47499, '/state')
        adb('shell', 'am', 'force-stop', PKG); adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS'); adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity'); time.sleep(4)
        tap('Join a CLAN'); type_('Six digit classroom code', cls['code']); type_('Host address', cls['bootstrap']); tap('Join')
        until(lambda: any(m['status'] == 'approved' and m['connected'] for m in http(47499, '/state')['members']), 'joined', 60)
        http(47499, '/wall', {'mode': 'WHITEBOARD'}); time.sleep(2)  # pen is the default tool
        x0, y0 = find('board-canvas')
        results, have = [], 0
        for total in stages:
          try:
            http(47499, '/strokes', {'count': total - have}); have = total
            until(lambda: len(http(47499, '/state')['board']) >= total, f'{total} strokes on the host', 180); time.sleep(8)  # phone catches up
            adb('shell', 'dumpsys', 'gfxinfo', PKG, 'reset')
            for i in range(30): adb('shell', 'input', 'swipe', str(x0 - 300), str(y0 - 150 + (i % 10) * 30), str(x0 + 300), str(y0 - 120 + (i % 10) * 30), '300')
            time.sleep(2)
            r = {'strokes': total, **frames(), 'appPssMiB': pss(lambda n: n == PKG), 'webviewRendererPssMiB': pss(lambda n: 'sandboxed_process' in n or 'webview' in n.lower())}
          except Exception as e:  # a crash (e.g. OOM) is a result, not a reason to lose the earlier stages
            r = {'strokes': total, 'failed': repr(e)[:200], 'appAlive': bool(adb('shell', 'pidof', PKG).strip())}
          print(json.dumps(r), flush=True); results.append(r)
          if 'failed' in r: break
        out = f'design/beta/bench-board-{label}.json'
        os.makedirs(os.path.dirname(out), exist_ok=True); json.dump({'label': label, 'emulator': 'Android 16 arm64 (Pixel profile), release build', 'results': results}, open(out, 'w'), indent=2)
    finally: host.kill(); host.wait()

if __name__ == '__main__': main()
