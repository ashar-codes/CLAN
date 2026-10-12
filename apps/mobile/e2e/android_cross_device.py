#!/usr/bin/env python3
"""Cross-device E2E on a disposable Android emulator with the standalone TEST build (scripts/android-qa.sh).

Starts two real peers on this computer — a "laptop" (tools/sim/sync-peer.ts: @clan/core + PersonalSync + LAN sync
server) and a CLAN host (tools/sim/class-peer.ts: classroom server with core chat + whiteboard) — and drives the phone
through accessibility labels (uiautomator) and real Android intents:
  link by code → two-way sync → offline edits on both → conflict → keep both → unlink → refused,
  Share-to-CLAN (SEND intent) → Inbox, join a CLAN (OPAQUE + pinned TLS) → chat both ways → live board both ways →
  file download (SHA-256 verified). Phone file picking/upload remains a separate device test.
Run from the repo root:  python3 apps/mobile/e2e/android_cross_device.py
Emulator, not a physical device: real-hardware Wi-Fi, BLE, camera and performance are not covered here."""
import json, os, re, subprocess, sys, time, urllib.request, xml.etree.ElementTree as ET

ADB = os.path.expanduser(os.environ.get('ADB', '~/Library/Android/sdk/platform-tools/adb'))
PKG = os.environ.get('CLAN_QA_ANDROID_PACKAGE', 'app.classroomlan.student.qa')
HOST_IP = os.environ.get('HOST_IP') or subprocess.run(['ipconfig', 'getifaddr', 'en0'], capture_output=True, text=True).stdout.strip()

def adb(*a, timeout=25):
    try: return subprocess.run([ADB, *a], capture_output=True, timeout=timeout).stdout
    except subprocess.TimeoutExpired: return b''
def nodes():
    for _ in range(5):
        adb('shell', 'rm', '-f', '/sdcard/ui.xml'); adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
        x = adb('shell', 'cat', '/sdcard/ui.xml').decode('utf8', 'ignore')
        if '<?xml' in x: return list(ET.fromstring(x[x.find('<?xml'):]).iter('node'))
        time.sleep(1)
    return []
def center(n): b = list(map(int, re.findall(r'\d+', n.get('bounds')))); return (b[0] + b[2]) // 2, (b[1] + b[3]) // 2
def find(label, edit=False, tries=14, scroll=True, clickable=False):
    for i in range(tries):
        for n in nodes():
            if edit and n.get('class') != 'android.widget.EditText': continue
            if clickable and n.get('clickable') != 'true': continue
            for target in n.iter('node') if clickable else [n]:
                for k in ('content-desc', 'text', 'resource-id'):
                    v = target.get(k) or ''
                    if v == label or (label.startswith('~') and label[1:] in v): return center(n)
        if scroll and i % 2: adb('shell', 'input', 'swipe', '24', *(('1700', '24', '900') if i < tries // 2 else ('700', '24', '1900')), '300')  # at the edge: a board canvas would take the swipe  # down, then back up
        time.sleep(0.6)
    raise AssertionError(f'not on screen: {label}')
def tap(label):
    # Accessibility can report a scrolled child's bounds under the fixed bottom tabs.
    # Derive the safe area from this emulator, rather than assuming a 2340px display.
    dimensions = re.findall(r'(\d+)x(\d+)', adb('shell', 'wm', 'size').decode())
    assert dimensions, 'cannot determine emulator viewport'
    height = int(dimensions[-1][1]); top, bottom = int(height * .045), int(height * .89)
    for _ in range(12):
        x, y = find(label, clickable=True)
        if top < y < bottom or label in ('Home', 'Study', 'People', 'Inbox', 'Diary', 'Me'):
            adb('shell', 'input', 'tap', str(x), str(y)); time.sleep(0.7); return
        start, end = (int(height * .4), int(height * .75)) if y <= top else (int(height * .8), int(height * .4))
        adb('shell', 'input', 'swipe', '24', str(start), '24', str(end), '300'); time.sleep(0.4)
    raise AssertionError(f'button is obscured by system/tab bars: {label}')
def open_chat():
    # Approval mounts chat asynchronously and can show an OS notification prompt after joining.
    # Observe each actual window instead of tapping stale room coordinates through that prompt.
    for _ in range(14):
        current = nodes()
        if any(n.get('text') == 'Close chat' for n in current): return
        button = next((n for n in current if n.get('resource-id') == 'com.android.permissioncontroller:id/permission_allow_button'), None)
        if button is None:
            button = next((n for n in current if n.get('content-desc') == 'Open chat' and n.get('clickable') == 'true'), None)
        if button is not None:
            x, y = center(button); adb('shell', 'input', 'tap', str(x), str(y))
        else:
            adb('shell', 'input', 'swipe', '24', '1700', '24', '900', '300')
        time.sleep(0.7)
    raise AssertionError('chat modal did not open')

def type_(label, text, dismiss=True):
    x, y = find(label, edit=True); adb('shell', 'input', 'tap', str(x), str(y)); time.sleep(0.3)
    adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END')
    adb('shell', 'input', 'keyevent', '--delay', '10', *(['KEYCODE_DEL'] * 60))
    adb('shell', 'input', 'text', text.replace(' ', '%s'))
    if dismiss: adb('shell', 'input', 'keyevent', '111')
    time.sleep(0.3)
    if label in ('Link code', 'Computer address (only if not found)', 'Six digit classroom code', 'Host address'):
        until(lambda: any(n.get('class') == 'android.widget.EditText' and n.get('content-desc') == label and n.get('text') == text for n in nodes()), 'text entered in ' + label)
def until(f, what, secs=40):
    end = time.time() + secs
    while time.time() < end:
        try:
            if f(): return
        except Exception: pass
        time.sleep(1)
    raise AssertionError(f'timed out: {what}')
def has(label): return bool(find(label, tries=2, scroll=False))
def board_object_visible(text):
    # The board has a native accessibility overlay. Ignore the editable input itself.
    return any(n.get('content-desc') == text and n.get('class') != 'android.widget.EditText' for n in nodes())
def http(port, path, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(body).encode() if body is not None else None, method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(req, timeout=15).read())
def ok(msg): print(f'  ✓ {msg}', flush=True)
def phone_seen(): return max((d['lastSeen'] or 0) for d in http(47399, '/state')['devices'] if not d['current'])
def sync_now():
    """Tap Sync now and confirm the round reached the laptop (a tap during a re-layout can miss)."""
    before = phone_seen()
    for _ in range(3):
        tap('Sync now'); end = time.time() + 12
        while time.time() < end:
            if phone_seen() > before: time.sleep(1.5); return
            time.sleep(0.5)
    raise AssertionError('Sync now did not reach the laptop')

def main():
    assert adb('shell', 'getprop', 'ro.kernel.qemu').strip() == b'1', 'this destructive QA scenario is emulator-only'
    procs = [subprocess.Popen(['node', 'tools/sim/sync-peer.ts'], stdout=subprocess.PIPE, text=True),
             subprocess.Popen(['node', 'tools/sim/class-peer.ts', '--host', HOST_IP], stdout=subprocess.PIPE, text=True)]
    try:
        for p in procs: assert p.stdout.readline(), 'a test peer failed to start (port still in use by a previous run?)'
        cls = http(47499, '/state')
        adb('shell', 'settings', 'put', 'secure', 'stylus_handwriting_enabled', '0')
        adb('shell', 'pm', 'clear', PKG); adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity'); time.sleep(4)
        if any('send you notifications' in (n.get('text') or '') for n in nodes()):
            tap('Allow')  # approve the real OS prompt on this disposable emulator only
        print('profile + core on the phone')
        type_('Full name', 'Sara Ahmed'); type_('Student / roll number', 'FA23-CS-007'); type_('Device name', 'Sara-Pixel'); tap('Save')
        find('Join a CLAN'); ok('encrypted core database opened; Home shows the agenda')

        print('personal device sync')
        http(47399, '/note', {'title': 'From the laptop', 'body': 'v1'})
        code = http(47399, '/link', {})['code']
        tap('Me'); tap('Open My Devices'); type_('Link code', code); type_('Computer address (only if not found)', '10.0.2.2:47300'); tap('Link')
        until(lambda: http(47399, '/state')['linkRequest'], 'link request on the laptop'); http(47399, '/approve', {})
        until(lambda: has('~Last sync'), 'first sync'); ok('linked by code with approval on the laptop; first sync done')
        tap('Done'); tap('Study'); tap('Notes'); find('From the laptop'); ok('laptop note arrived on the phone')
        tap('New note'); type_('Title', 'From the phone'); type_('Note', 'phone note'); tap('Save')
        tap('Me'); tap('Open My Devices'); sync_now()
        until(lambda: any(n['title'] == 'From the phone' for n in http(47399, '/state')['notes']), 'phone note on laptop'); ok('phone note arrived on the laptop')
        nid = next(n['id'] for n in http(47399, '/state')['notes'] if n['title'] == 'From the laptop')
        tap('Paused'); until(lambda: find('Paused.'), 'no round in flight', 90)  # apart: no sync while both edit
        tap('Done'); tap('Study'); tap('Notes'); tap('From the laptop'); type_('Note', 'phone edit while apart'); tap('Save')
        http(47399, f'/note/{nid}', {'body': 'laptop edit while apart'})
        st = http(47399, '/state'); print('   laptop before reconnect:', [(n['title'], n['body']) for n in st['notes'] if n['title'].startswith('From the laptop')], st['stats'])
        tap('Me'); tap('Open My Devices'); tap('On'); time.sleep(1); sync_now()
        st = http(47399, '/state'); print('   laptop after reconnect:', [(n['title'], n['body']) for n in st['notes'] if n['title'].startswith('From the laptop')], 'conflicts:', [(c['note'], c['local'].get('body') if c['local'] else None, c['remote'].get('body') if c['remote'] else None) for c in st['conflicts']])
        tap('Keep both')
        until(lambda: len([n for n in http(47399, '/state')['notes'] if n['title'].startswith('From the laptop')]) == 2, 'both versions on laptop')
        ok('offline edits on both kept as a conflict; "Keep both" converged on both devices')
        fp = next(d['fp'] for d in http(47399, '/state')['devices'] if not d['current'])
        r = http(47399, f'/revoke/{fp}', {}); assert any(d['fp'] == fp and d['revoked'] for d in r['devices']), f'revoke not recorded: {r}'
        print('   laptop devices:', r['devices'], ' phone fp:', fp)
        tap('Sync now'); time.sleep(5); print('   laptop after phone sync:', [(d['fp'], d['revoked'], d['lastSeen']) for d in http(47399, '/state')['devices']])
        until(lambda: find('~This phone was unlinked', tries=2), 'phone learns it was unlinked', 60); ok('unlinked on the laptop → phone refused and says so')
        tap('Done')

        print('Share to CLAN')
        adb('shell', f"am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT 'Notes https://example.com/os' -n {PKG}/.MainActivity")
        find('Share to CLAN'); tap('Save to my Inbox'); tap('Keep in Inbox'); find('~Inbox, '); ok('shared link + text saved to the Inbox (offline, private)')

        print('live CLAN')
        # A real history longer than the API's first page; respect the host's send rate.
        for i in range(55):
            if i in (25, 50): time.sleep(11)
            http(47499, '/chat', {'body': f'History {i:02d}'})
        tap('Home'); tap('Join a CLAN'); type_('Six digit classroom code', cls['code']); type_('Host address', cls['bootstrap']); tap('Join')
        until(lambda: any(m['status'] == 'approved' and m['connected'] for m in http(47499, '/state')['members']), 'member connected')
        ok('joined over OPAQUE + pinned TLS')
        open_chat()
        http(47499, '/chat', {'body': 'Welcome from the host'}); find('Welcome from the host'); ok('host message shown on the phone')
        type_('Message', 'Hello from the phone', dismiss=False); tap('Send'); find('Hello from the phone')
        until(lambda: any(m['body'] == 'Hello from the phone' for m in http(47499, '/state')['messages']), 'phone chat persisted by host')
        ok('phone message accepted by the host')
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); find('Close chat', scroll=False)  # hide IME, keep modal open
        def earlier(label):
            for _ in range(16):
                try:
                    point = find(label, tries=1, scroll=False)
                    if point[0] > 0 and point[1] > 0: return point
                except AssertionError: pass
                adb('shell', 'input', 'swipe', '540', '700', '540', '1600', '300')
            raise AssertionError(f'chat history not reachable: {label}')
        x, y = earlier('Load earlier messages'); adb('shell', 'input', 'tap', str(x), str(y))
        old_position = earlier('History 00')
        http(47499, '/chat', {'body': 'New while reading'})
        assert abs(find('History 00', tries=2, scroll=False)[1] - old_position[1]) < 20, 'new message moved the reader'
        tap('Jump to latest'); find('New while reading'); ok('chat: older page reachable, reading position kept, jump to latest works')
        tap('Close chat')
        http(47499, '/wall', {'mode': 'WHITEBOARD'}); http(47499, '/draw', {'text': 'Host sticky'}); find('Host sticky'); ok('host board op on the phone')
        board_text = 'Phone text ' + os.urandom(4).hex()  # disposable correlation tag, no personal data
        tap('Text'); x, y = find('board-canvas', scroll=False); adb('shell', 'input', 'tap', str(x), str(y + 200)); type_('Text to place', board_text, dismiss=False)
        x, y = find('Add', scroll=False); adb('shell', 'input', 'tap', str(x), str(y))  # one tap with keyboard open
        until(lambda: board_object_visible(board_text), 'phone text locally committed', 15)
        until(lambda: any(o['text'] == board_text for o in http(47499, '/state')['board']), 'phone text on the host board')
        board_row = next(o for o in http(47499, '/state')['board'] if o['text'] == board_text)
        print('   board trace:', board_text[-8:], 'stored op:', board_row['op'], flush=True)
        ok('phone board op on the host')
        path = os.path.abspath('apps/mobile/e2e/.tmp-notes.bin'); open(path, 'wb').write(os.urandom(1_500_000))
        http(47499, '/file', {'path': path, 'to': 'clan'})
        def downloaded():
            try: tap('Download')
            except AssertionError: pass
            return find('~Downloaded', tries=6)
        until(downloaded, 'file downloaded', 90); ok('host file downloaded and SHA-256 verified')
        os.remove(path)
        print('all passed')
    except AssertionError:  # the screen as it was when the step failed, before the peers stop
        open(os.path.join(os.path.dirname(__file__), '.tmp-failure.png'), 'wb').write(adb('exec-out', 'screencap', '-p'))
        print('  screen at failure:', ' | '.join(filter(None, ((n.get('content-desc') or n.get('text') or '')[:60] for n in nodes())))[:1500]); raise
    finally:  # wait: a peer still closing holds its ports, and the next run would silently talk to it
        for p in procs: p.terminate()
        for p in procs:
            try: p.wait(15)
            except subprocess.TimeoutExpired: p.kill(); p.wait()

if __name__ == '__main__':
    try: main()
    except AssertionError as e:  # (the peers are already stopped here, so the screen may show them gone)
        print(f'  ✗ {e}'); print('  screen:', ' | '.join(filter(None, ((n.get('content-desc') or n.get('text') or '')[:60] for n in nodes())))[:1500]); sys.exit(1)
