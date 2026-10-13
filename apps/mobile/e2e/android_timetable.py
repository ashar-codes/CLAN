#!/usr/bin/env python3
"""Timetable native UI persistence on a disposable emulator only. Never clear user data."""
import time
import android_cross_device as ui

def type_slow(label,text):
    ui.type_(label,'',dismiss=False)
    for char in text:
        ui.adb('shell','input','text','%s' if char==' ' else char);time.sleep(.08)
    ui.until(lambda:any(n.get('class')=='android.widget.EditText' and n.get('content-desc')==label and n.get('text')==text for n in ui.nodes()),'exact native field contents: '+label,secs=15)
    ui.adb('shell','input','keyevent','KEYCODE_BACK');time.sleep(.5)

def version_action(name,label):
    import re
    height=int(re.findall(r'(\d+)x(\d+)',ui.adb('shell','wm','size').decode())[-1][1])
    for _ in range(18):
        for container in reversed(ui.nodes()):
            children=list(container.iter('node'))
            if not any((n.get('text') or '').startswith(name) for n in children):continue
            button=next((n for n in children if n.get('content-desc')==label and n.get('clickable')=='true'),None)
            if button is not None:
                x,y=ui.center(button)
                if height*.06<y<height*.84:
                    ui.adb('shell','input','tap',str(x),str(y));time.sleep(.7);return
        ui.adb('shell','input','swipe','24',str(int(height*.8)),'24',str(int(height*.4)),'300');time.sleep(.4)
    raise AssertionError('Version action not visible: '+name+' / '+label)

def main():
    assert ui.adb('shell','getprop','ro.kernel.qemu').strip()==b'1', 'Disposable emulator only'
    ui.adb('shell','am','start','-n',ui.ACTIVITY); time.sleep(4)
    if any(n.get('content-desc')=='Full name' for n in ui.nodes()):
        ui.type_('Full name','Timetable QA');ui.type_('Student / roll number','QA-TT');ui.type_('Device name','Disposable emulator');ui.tap('Save')
    name='Native timetable QA '+str(int(time.time()));subject='Mathematics '+str(int(time.time()))
    ui.tap('Study');ui.tap('Timetable');ui.tap('Create timetable');type_slow('Timetable name',name)
    type_slow('Period subject',subject);type_slow('Period teacher','Teacher QA');type_slow('Period room','Room 42');ui.tap('Save period');ui.tap('Save timetable')
    ui.find('~'+name);version_action(name,'Select active');ui.find('~'+name)
    print('PASS native manual entry and active selection',flush=True)
    ui.adb('shell','am','force-stop',ui.PKG);ui.adb('shell','am','start','-n',ui.ACTIVITY);time.sleep(4)
    ui.tap('Study');ui.tap('Timetable');ui.find('~'+name);version_action(name,'Edit timetable');ui.find('~'+subject);ui.tap('Cancel timetable edit')
    version_action(name,'Archive timetable');version_action(name,'Restore timetable');version_action(name,'Select active')
    print('PASS native restart persistence, archive and restore; physical device NOT TESTED',flush=True)
if __name__=='__main__':main()
