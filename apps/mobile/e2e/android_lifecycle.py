#!/usr/bin/env python3
"""Native archive/restore and member leave on a disposable Android emulator.
Clears ONLY the installed test app's profile; never run with a personal emulator/profile.
Refuses physical devices. Run after installing the Phase 14.2 release APK, from repo root.
"""
from android_cross_device import PKG, HOST_IP, adb, find, http, ok, subprocess, tap, time, type_, until, open_chat

def main():
    assert adb('shell', 'getprop', 'ro.kernel.qemu').strip() == b'1', 'Emulator only; physical data must not be cleared'
    host = subprocess.Popen(['node', 'tools/sim/class-peer.ts', '--host', HOST_IP], stdout=subprocess.PIPE, text=True)
    try:
        assert host.stdout.readline(), 'test peer failed to start'
        cls = http(47499, '/state')
        adb('shell', 'pm', 'clear', PKG); adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity'); time.sleep(3)
        type_('Full name', 'Lifecycle Tester'); type_('Student / roll number', 'TEST-142'); type_('Device name', 'Disposable Android'); tap('Save')
        tap('Study'); tap('Notes'); tap('New note'); type_('Title', 'Personal kept after leave'); tap('Save')
        def join():
            tap('Home'); tap('Join a CLAN'); type_('Six digit classroom code', cls['code']); type_('Host address', cls['bootstrap']); tap('Join')
            until(lambda: any(m['status'] == 'approved' and m['connected'] for m in http(47499, '/state')['members']), 'member approved and connected')
            open_chat(); tap('Close chat')  # also resolves a real notification permission prompt
        join(); tap('Leave CLAN')  # existing session disconnect preserves membership
        tap('Home'); tap('Archive Phone test group'); tap('ARCHIVE'); find('Restore Phone test group'); ok('archive confirmation shown')
        adb('shell', 'am', 'force-stop', PKG); adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity'); time.sleep(3)
        find('Restore Phone test group'); tap('Restore Phone test group'); find('Archive Phone test group'); ok('archive persists across restart; restore works')
        join(); tap('Leave membership'); tap('LEAVE')
        until(lambda: any(m['status'] == 'removed' for m in http(47499, '/state')['members']), 'host revoked the caller')
        find('Join a CLAN'); ok('native leave revoked host session and returned to Home')
        tap('Study'); tap('Notes'); find('Personal kept after leave'); ok('personal note retained')
        adb('shell', 'am', 'force-stop', PKG); adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity'); time.sleep(3)
        find('Join a CLAN')
        try: find('Archive Phone test group', tries=6)
        except AssertionError: pass
        else: raise AssertionError('left membership reappeared after restart')
        join(); ok('rejoined through existing OPAQUE and host approval policy')
    finally:
        host.terminate(); host.wait(timeout=30)

if __name__ == '__main__': main()
