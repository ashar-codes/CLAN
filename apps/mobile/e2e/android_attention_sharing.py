#!/usr/bin/env python3
"""Genuine native Raise Hand + Classroom sharing UI on a DISPOSABLE emulator.
Clears only this test app profile. Refuses physical devices. Run after installing the current release APK.
"""
import hashlib, pathlib, tempfile
from android_cross_device import PKG, HOST_IP, adb, find, http, nodes, ok, subprocess, tap, time, type_, until, open_chat

def main():
    assert adb('shell', 'getprop', 'ro.kernel.qemu').strip() == b'1', 'Emulator only; no physical profile clearing'
    host = subprocess.Popen(['node', 'tools/sim/class-peer.ts', '--host', HOST_IP, '--type', 'CLASSROOM'], stdout=subprocess.PIPE, text=True)
    try:
        assert host.stdout.readline(), 'test peer failed to start'
        cls = http(47499, '/state')
        adb('shell', 'pm', 'clear', PKG); adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity'); time.sleep(3)
        type_('Full name', 'Attention Tester'); type_('Student / roll number', 'TEST-142'); type_('Device name', 'Disposable Android'); tap('Save')
        tap('Join a CLAN'); type_('Six digit classroom code', cls['code']); type_('Host address', cls['bootstrap']); tap('Join')
        until(lambda: any(m['status'] == 'approved' and m['connected'] for m in http(47499, '/state')['members']), 'approved over production transport')
        open_chat(); tap('Close chat')
        tap('Raise hand'); find('Lower hand'); until(lambda: len(http(47499, '/state')['hands']) == 1, 'host received one hand')
        member = http(47499, '/state')['hands'][0]['memberId']; http(47499, '/hand/dismiss', {'memberId': member}); find('Raise hand'); ok('native Raise Hand/host acknowledgment round trip')
        tap('Raise hand'); find('Lower hand'); tap('Lower hand'); find('Raise hand'); until(lambda: not http(47499, '/state')['hands'], 'lower hand persisted in live host'); ok('native lower-hand acknowledgment')
        open_chat()
        assert not any(n.get('content-desc') == 'Send a file to everyone' for n in nodes()), 'teacher-only policy exposes file control'
        ok('teacher-only Classroom hides member file send')
        http(47499, '/file-policy', {'policy': 'approval'}); find('Send a file to everyone')
        with tempfile.TemporaryDirectory(prefix='clan-native-policy-') as temporary:
            source = pathlib.Path(temporary) / 'clan-142-policy.txt'; source.write_text('Original native policy test file.\n'); digest = hashlib.sha256(source.read_bytes()).hexdigest()
            subprocess.run([str(pathlib.Path.home() / 'Library/Android/sdk/platform-tools/adb'), 'push', str(source), '/sdcard/Download/clan-142-policy.txt'], check=True, capture_output=True)
            def select_file():
                tap('Send a file to everyone')
                tap('Show roots'); tap('Downloads'); tap('clan-142-policy.txt')
            select_file(); find('Sent for teacher approval. Approved files appear in Classroom files.')
            until(lambda: len(http(47499, '/state')['pendingShares']) == 1, 'pending host review')
            state = http(47499, '/state'); assert not state['files'], 'unapproved native file published'
            http(47499, '/share/review', {'uploadId': state['pendingShares'][0]['uploadId'], 'accept': True})
            until(lambda: any(f['name'] == source.name and f['sha256'] == digest for f in http(47499, '/state')['files']), 'approved exact native bytes visible')
            ok('native approval policy quarantines then publishes verified file')
        http(47499, '/file-policy', {'policy': 'teacher'}); time.sleep(1)
        assert not any(n.get('content-desc') == 'Send a file to everyone' for n in nodes()), 'policy change did not hide control'
        ok('live teacher-only policy reapplied')
    finally:
        host.terminate(); host.wait(timeout=30)

if __name__ == '__main__': main()
