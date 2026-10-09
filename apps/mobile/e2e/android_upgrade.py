#!/usr/bin/env python3
"""Android install → upgrade on the emulator, with a disposable laptop (tools/sim/sync-peer.ts):
  clean install of OLD → profile, note, Diary, device linked to the laptop and synced → `adb install -r NEW`
  → versionCode went up, profile/note/Diary kept, still linked with the same device identity (the laptop accepts its
  signed sync without re-linking, so the Keystore keys and pinned TLS survived), sync still works both ways.
  Finally an APK signed with a different key must be refused as an update (data stays).
Usage: python3 apps/mobile/e2e/android_upgrade.py OLD.apk NEW.apk [OTHER_KEY.apk]"""
import os, re, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from android_cross_device import PKG, adb, find, http, ok, tap, type_, until, sync_now

def has(label):
    try: return bool(find(label, tries=2, scroll=False))
    except AssertionError: return False
def version(): return int(re.search(r'versionCode=(\d+)', adb('shell', 'dumpsys', 'package', PKG).decode())[1])
def start(): adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity'); time.sleep(4)
def phone_device(): return next(d for d in http(47399, '/state')['devices'] if not d['current'])

def main():
    old, new = sys.argv[1], sys.argv[2]
    peer = subprocess.Popen(['node', 'tools/sim/sync-peer.ts'], stdout=subprocess.PIPE, text=True)
    try:
        assert peer.stdout.readline(), 'sync peer failed to start (port in use?)'
        adb('uninstall', PKG); adb('install', old, timeout=120); adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS')
        v1 = version(); start()
        print(f'clean install (versionCode {v1})')
        type_('Full name', 'Sara Ahmed'); type_('Student / roll number', 'FA23-CS-007'); type_('Device name', 'Sara-Pixel'); tap('Save'); find('Join a CLAN')
        tap('Study'); tap('Notes'); tap('New note'); type_('Title', 'Before the upgrade'); type_('Note', 'kept'); tap('Save'); find('Before the upgrade')
        tap('Diary'); type_('Today', 'Private before the upgrade'); tap('Save')
        http(47399, '/note', {'title': 'From the laptop', 'body': 'v1'})
        code = http(47399, '/link', {})['code']
        tap('Me'); tap('Open My Devices'); type_('Link code', code); type_('Computer address (only if not found)', '10.0.2.2:47300'); tap('Link')
        until(lambda: http(47399, '/state')['linkRequest'], 'link request on the laptop'); http(47399, '/approve', {})
        until(lambda: has('~Last sync'), 'first sync'); sync_now()
        until(lambda: any(n['title'] == 'Before the upgrade' for n in http(47399, '/state')['notes']), 'phone note on the laptop')
        fp = phone_device()['fp']; ok(f'linked (device {fp[:8]}…) and synced')

        adb('install', '-r', new, timeout=120); v2 = version()
        assert v2 > v1, f'versionCode did not increase ({v1} → {v2})'
        start(); assert not has('Your details'), 'onboarding shown again: profile lost'
        find('Join a CLAN'); ok(f'upgraded in place ({v1} → {v2}); profile kept')
        tap('Study'); tap('Notes'); find('Before the upgrade'); find('From the laptop'); ok('notes kept')
        tap('Diary'); find('Private before the upgrade'); ok('Diary kept (encrypted database opened with the same Keystore key)')
        http(47399, '/note', {'title': 'After the upgrade', 'body': 'v2'})
        tap('Me'); tap('Open My Devices'); find('~Last sync')  # the laptop is still listed as linked
        sync_now(); d = phone_device()
        assert d['fp'] == fp and not d['revoked'], f'device identity changed: {fp} → {d["fp"]}'
        tap('Done'); tap('Study'); tap('Notes'); find('After the upgrade')
        ok('same device identity, still linked, signed sync over the pinned certificate works both ways')

        if len(sys.argv) > 3:
            r = subprocess.run([os.path.expanduser(os.environ.get('ADB', '~/Library/Android/sdk/platform-tools/adb')), 'install', '-r', sys.argv[3]], capture_output=True, text=True)
            assert r.returncode != 0 and 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' in (r.stdout + r.stderr), r.stdout + r.stderr
            assert version() == v2; start(); tap('Study'); tap('Notes'); find('Before the upgrade')
            ok('an APK signed with another key is refused as an update; data untouched')
        print('all passed')
    finally: peer.kill(); peer.wait()

if __name__ == '__main__': main()
