#!/usr/bin/env python3
"""Timetable native UI persistence on a disposable emulator only. Never clear user data."""
import time
import android_cross_device as ui

def main():
    assert ui.adb('shell','getprop','ro.kernel.qemu').strip()==b'1', 'Disposable emulator only'
    ui.adb('shell','am','start','-n',ui.ACTIVITY); time.sleep(4)
    if any(n.get('content-desc')=='Full name' for n in ui.nodes()):
        ui.type_('Full name','Timetable QA');ui.type_('Student / roll number','QA-TT');ui.type_('Device name','Disposable emulator');ui.tap('Save')
    ui.tap('Study');ui.tap('Timetable');ui.tap('Create timetable');ui.type_('Timetable name','Native timetable QA')
    ui.type_('Period subject','Mathematics QA');ui.type_('Period teacher','Teacher QA');ui.type_('Period room','Room 42');ui.tap('Save period');ui.tap('Save timetable')
    ui.find('~Native timetable QA');ui.tap('Select active');ui.find('~Native timetable QA')
    print('PASS native manual entry and active selection',flush=True)
    ui.adb('shell','am','force-stop',ui.PKG);ui.adb('shell','am','start','-n',ui.ACTIVITY);time.sleep(4)
    ui.tap('Study');ui.tap('Timetable');ui.find('~Native timetable QA');ui.tap('Edit timetable');ui.find('~Mathematics QA');ui.tap('Cancel timetable edit')
    ui.tap('Archive timetable');ui.find('Restore timetable');ui.tap('Restore timetable');ui.tap('Select active')
    print('PASS native restart persistence, archive and restore; physical device NOT TESTED',flush=True)
if __name__=='__main__':main()
