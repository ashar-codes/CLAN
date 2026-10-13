#!/usr/bin/env python3
"""Native lifecycle/confirmation/editor test. Disposable emulator only, no profile clearing."""
import time
import android_cross_device as ui
from android_timetable import type_slow

def main():
    ui.SCROLL_X = '100'  # Inside the native scroll responder, away from OS edge gestures.
    assert ui.adb('shell','getprop','ro.kernel.qemu').strip()==b'1','Disposable emulator only'
    ui.adb('shell','am','start','-n',ui.ACTIVITY);time.sleep(4)
    if any(n.get('content-desc')=='Full name' for n in ui.nodes()):
        type_slow('Full name','Content QA');type_slow('Student / roll number','QA-2E');type_slow('Device name','Disposable emulator');ui.tap('Save')
    name='Course '+str(int(time.time()));renamed=name+' edited';note='Note '+str(int(time.time()))
    ui.tap('Study');ui.tap('Courses');type_slow('Course name',name);ui.tap('Add course');type_slow('Search courses',name);ui.tap('Edit '+name)
    type_slow('Course name',renamed);type_slow('Instructor','QA teacher');ui.tap('Save');ui.find('~'+renamed)
    ui.tap('Archive '+renamed);ui.tap('Archived courses');ui.find('Restore '+renamed);ui.tap('Restore '+renamed);ui.tap('Show active courses');ui.find('Edit '+renamed)
    ui.tap('Delete course '+renamed);ui.tap('CANCEL');ui.find('Edit '+renamed)
    ui.tap('Delete course '+renamed);ui.tap('DELETE')
    ui.tap('Notes');ui.tap('New note');type_slow('Title',note);type_slow('Note','Persistent private fixture');ui.tap('Save');ui.find('Open note '+note)
    ui.adb('shell','am','force-stop',ui.PKG);ui.adb('shell','am','start','-n',ui.ACTIVITY);time.sleep(4);ui.tap('Study');ui.tap('Notes');ui.find('Open note '+note)
    ui.tap('Delete note '+note);ui.tap('CANCEL');ui.find('Open note '+note);ui.tap('Delete note '+note);ui.tap('DELETE')
    assert not any(n.get('content-desc')=='Open note '+note for n in ui.nodes()),'deleted note still visible'
    print('PASS native course edit/archive/restore, named delete cancellation/confirmation, Note editor and restart persistence; physical NOT TESTED',flush=True)
if __name__=='__main__':main()
