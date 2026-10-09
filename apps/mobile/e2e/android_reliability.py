#!/usr/bin/env python3
"""Phone reliability on the emulator (needs `adb root`, i.e. a non-Play emulator image; installed release build):
  1. crash mid-use (SIGKILL right after saving a note) → relaunch keeps the note
  2. offline personal use (airplane mode: Wi-Fi + data off) → a note can be written and read back
  3. live CLAN: leave and join again after the join bridge was released; host unresponsive 20 s (process frozen: laptop asleep / dead link) → phone reconnects; network lost (airplane mode) → reconnects
  4. permission denial (camera) → Inbox › Take a photo says how to turn it on; the rest of the Inbox still works
  5. unreadable database (stands in for data restored onto another phone: the key can't unlock it) → kept aside, fresh
     start, Home explains how to get data back
Usage: python3 apps/mobile/e2e/android_reliability.py"""
import os, signal, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from android_cross_device import PKG, HOST_IP, adb, find, http, ok, tap, type_, until

DATA = f'/data/data/{PKG}/files/SQLite'
def start(): adb('shell', 'am', 'start', '-n', f'{PKG}/.MainActivity'); time.sleep(3)
def add_note(title):
    tap('Study'); tap('Notes'); tap('New note'); type_('Title', title); tap('Save'); find(title)
def has(label):
    try: return bool(find(label, tries=2, scroll=False))
    except AssertionError: return False
def host():
    p = subprocess.Popen(['node', 'tools/sim/class-peer.ts', '--host', HOST_IP], stdout=subprocess.PIPE, text=True)
    assert p.stdout.readline(), 'test host failed to start (port in use?)'; return p

def main():
    assert b'root' in adb('shell', 'id'), 'needs `adb root`'
    adb('shell', 'am', 'force-stop', PKG); adb('shell', 'pm', 'clear', PKG); adb('shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS')
    start(); type_('Full name', 'Sara Ahmed'); type_('Student / roll number', 'FA23-CS-007'); type_('Device name', 'Sara-Pixel'); tap('Save'); find('Join a CLAN')

    print('crash / relaunch')
    add_note('Saved before the crash')
    adb('shell', 'am', 'kill', PKG); adb('shell', 'pkill', '-9', '-f', PKG); time.sleep(1)
    assert not adb('shell', 'pidof', PKG).strip(), 'app still running'
    start(); tap('Study'); tap('Notes'); find('Saved before the crash'); ok('SIGKILL right after saving: the note is there after relaunch')

    print('offline personal use')
    adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'); time.sleep(3)
    try:
        add_note('Written offline'); adb('shell', 'am', 'force-stop', PKG); start(); tap('Study'); tap('Notes'); find('Written offline')
        ok('airplane mode: note written, app restarted, note still there')
    finally: adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'); time.sleep(6)

    print('live CLAN interruptions')
    h = host()
    try:
        cls = http(47499, '/state')
        tap('Home'); tap('Join a CLAN'); type_('Six digit classroom code', cls['code']); type_('Host address', cls['bootstrap']); tap('Join')
        connected = lambda: any(m['status'] == 'approved' and m['connected'] for m in http(47499, '/state')['members'])
        until(connected, 'member connected', 60); ok('joined')
        http(47499, '/chat', {'body': 'Before the freeze'}); find('Before the freeze'); ok('messages flow')
        h.send_signal(signal.SIGSTOP); time.sleep(20); h.send_signal(signal.SIGCONT)
        until(connected, 'phone connected after the host woke', 90)
        http(47499, '/chat', {'body': 'After the host woke'}); find('After the host woke'); ok('host unresponsive 20 s: phone reconnected, messages flow')
        adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable')  # the emulator's cellular link also reaches the host: cut both
        until(lambda: not connected(), 'host notices the phone left', 60)
        adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable')
        until(connected, 'phone reconnected after the network came back', 120); ok('network lost until the host noticed → phone reconnected')
        http(47499, '/chat', {'body': 'After Wi-Fi'}); find('After Wi-Fi'); ok('messages flow after Wi-Fi interruption')
        tap('Leave CLAN'); time.sleep(65)  # the join bridge's WebView is released 60 s after its last use
        until(lambda: not connected(), 'host sees the phone left', 30)
        tap('Home'); tap('Join a CLAN'); type_('Six digit classroom code', cls['code']); type_('Host address', cls['bootstrap']); tap('Join')
        until(connected, 'joined again', 60); ok('left, bridge released, joined again (bridge re-mounted)')
    finally: h.kill(); h.wait(); adb('shell', 'cmd', 'connectivity', 'airplane-mode', 'disable')

    print('permission denial')
    adb('shell', 'am', 'force-stop', PKG); adb('shell', 'pm', 'revoke', PKG, 'android.permission.CAMERA'); start()
    tap('Inbox'); tap('Take a photo')
    for b in ('Don’t allow', "Don't allow", 'Deny'):
        if has(b): tap(b); break
    find('Camera permission is off. You can turn it on in Settings.'); ok('camera denied: Inbox says how to turn it on')
    type_('Text or link', 'still works'); tap('Save to Inbox'); find('still works'); ok('Inbox still usable without the camera')

    print('unreadable database')
    adb('shell', 'am', 'force-stop', PKG)
    adb('shell', f'dd if=/dev/urandom of={DATA}/clan.db bs=4096 count=8 2>/dev/null; rm -f {DATA}/clan.db-wal {DATA}/clan.db-shm')
    start(); find('This phone’s earlier CLAN data couldn’t be unlocked (it was kept, not deleted). Link this phone to your computer in Me › My Devices to bring your study data back.'); ok('Home explains the data could not be unlocked and how to get it back')
    kept = adb('shell', 'ls', DATA).decode()
    assert 'clan.db.unreadable-' in kept, kept; ok('unreadable data kept aside, not deleted')
    tap('Study'); tap('Notes'); add_note('Fresh after unreadable'); ok('fresh database works')
    print('all passed')

if __name__ == '__main__': main()
