// CLAN consent-scoped native input. No command/file/clipboard API. Never prints input text.
import Foundation
import AppKit
import ApplicationServices
import Carbon
let tag:Int64 = 0x434c414e5243
func output(_ value:[String:Any]) { if let d=try? JSONSerialization.data(withJSONObject:value) { FileHandle.standardOutput.write(d);FileHandle.standardOutput.write(Data([10])) } }
func permissions(_ prompt:Bool=false)->Bool {
 let ax=AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:prompt] as CFDictionary)
 let listen=CGPreflightListenEventAccess(); if prompt  &&  !listen { _=CGRequestListenEventAccess() }
 return ax  &&  listen  &&  CGPreflightScreenCaptureAccess()
}
func safe()->Bool { if let target=targetPid,NSWorkspace.shared.frontmostApplication?.processIdentifier != target{return false};if let id=NSWorkspace.shared.frontmostApplication?.bundleIdentifier,Set(["com.apple.loginwindow","com.apple.SecurityAgent","com.apple.systempreferences","com.apple.keychainaccess"]).contains(id){return false};let flags=CGEventSource.flagsState(.combinedSessionState); guard flags.intersection([.maskCommand,.maskControl,.maskAlternate,.maskSecondaryFn]).isEmpty, permissions(),!IsSecureEventInputEnabled(),let s=CGSessionCopyCurrentDictionary() as? [String:Any] else{return false};return s["CGSSessionScreenIsLocked"] as? Bool != true  &&  s["kCGSSessionOnConsoleKey"] as? Bool == true }
if CommandLine.arguments.contains("--check")  ||  CommandLine.arguments.contains("--request") {output(["available":permissions(CommandLine.arguments.contains("--request")),"platform":"macOS"]);exit(0)}
var targetPid:pid_t?=nil,displayId:CGDirectDisplayID=0
var active=false,deadline=Date.distantPast,expires=Date.distantPast,bounds=CGRect.zero,pressed=false,tap:CFMachPort?
func stop(){active=false;if pressed,let e=CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:CGEvent(source:nil)?.location ?? .zero,mouseButton:.left){e.setIntegerValueField(.eventSourceUserData,value:tag);e.post(tap:.cghidEventTap)};pressed=false;output(["stopped":true])}
let mask:CGEventMask = [CGEventType.keyDown,.leftMouseDown,.rightMouseDown,.mouseMoved,.scrollWheel].reduce(0){$0 | (1 << $1.rawValue)}
tap=CGEvent.tapCreate(tap:.cghidEventTap,place:.headInsertEventTap,options:.listenOnly,eventsOfInterest:mask,callback:{_,type,event,_ in
 if active  &&  (type == .tapDisabledByTimeout  ||  type == .tapDisabledByUserInput  ||  event.getIntegerValueField(.eventSourceUserData) != tag){stop()}
 return Unmanaged.passUnretained(event)
},userInfo:nil)
guard let tap=tap,permissions() else {output(["error":"Accessibility, Input Monitoring and Screen Recording permissions are required."]);exit(1)}
CFRunLoopAddSource(CFRunLoopGetMain(),CFMachPortCreateRunLoopSource(kCFAllocatorDefault,tap,0),.commonModes);CGEvent.tapEnable(tap:tap,enable:true)
func focusedInScope()->Bool {
 guard let app=NSWorkspace.shared.frontmostApplication,let id=app.bundleIdentifier,!Set(["com.apple.loginwindow","com.apple.SecurityAgent","com.apple.systempreferences","com.apple.keychainaccess"]).contains(id) else{return false}
 let element=AXUIElementCreateApplication(app.processIdentifier);var window:CFTypeRef?
 guard AXUIElementCopyAttributeValue(element,kAXFocusedWindowAttribute as CFString,&window) == .success,let window=window else{return false}
 var position:CFTypeRef?,size:CFTypeRef?
 guard AXUIElementCopyAttributeValue(window as! AXUIElement,kAXPositionAttribute as CFString,&position) == .success,AXUIElementCopyAttributeValue(window as! AXUIElement,kAXSizeAttribute as CFString,&size) == .success,let position=position,let size=size else{return false}
 var point=CGPoint.zero,dimensions=CGSize.zero
 guard AXValueGetValue(position as! AXValue,.cgPoint,&point),AXValueGetValue(size as! AXValue,.cgSize,&dimensions) else{return false}
 return bounds.contains(CGRect(origin:point,size:dimensions))
}
func post(_ e:CGEvent?){guard active,CGDisplayIsActive(displayId) != 0,CGDisplayBounds(displayId)==bounds,safe(),Date()<deadline,Date()<expires,let e=e else {stop();return};e.setIntegerValueField(.eventSourceUserData,value:tag);e.post(tap:.cghidEventTap)}
func packet(_ v:[String:Any]){
 guard let kind=v["kind"] as? String else {stop();return}
 if kind=="arm" {guard !active,safe(),let id=v["display"] as? UInt32,let seconds=v["seconds"] as? Double,seconds>0,seconds<=180,CGDisplayIsActive(id) != 0 else{stop();return};displayId=id;targetPid=v["pid"] as? pid_t;bounds=CGDisplayBounds(id);expires=Date().addingTimeInterval(seconds);deadline=Date().addingTimeInterval(1);active=true;output(["armed":true]);return}
 if kind=="stop"{stop();return};guard active,safe(),Date()<deadline,Date()<expires else{stop();return}
 if kind=="heartbeat"{deadline=Date().addingTimeInterval(1);return}
 guard kind=="input",let input=v["input"] as? [String:Any],let type=input["type"] as? String else{stop();return}
 if type=="pointer"{guard let x=input["x"] as? Double,let y=input["y"] as? Double,x.isFinite,y.isFinite,x>=0,x<=1,y>=0,y<=1,let action=input["action"] as? String else{stop();return};let point=CGPoint(x:bounds.minX+x*(bounds.width-1),y:bounds.minY+y*(bounds.height-1));
 let windows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
 for window in windows {if let data=window[kCGWindowBounds as String] as? [String:Any],let rect=CGRect(dictionaryRepresentation:data as CFDictionary),rect.contains(point),let owner=window[kCGWindowOwnerName as String] as? String,Set(["SecurityAgent","loginwindow","System Settings","Keychain Access"]).contains(owner){stop();return}}
 if action=="move"{post(CGEvent(mouseEventSource:nil,mouseType:pressed ? .leftMouseDragged:.mouseMoved,mouseCursorPosition:point,mouseButton:.left))}else if action=="down" || action=="up" {pressed=action=="down";post(CGEvent(mouseEventSource:nil,mouseType:pressed ? .leftMouseDown:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left))}else if action=="click"{post(CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:point,mouseButton:.left));post(CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:point,mouseButton:.left))}else{stop()}}
 else if type=="scroll"{guard let cursor=CGEvent(source:nil)?.location,bounds.contains(cursor),focusedInScope(),let delta=input["delta"] as? Int32,delta >= -10,delta <= 10 else{stop();return};post(CGEvent(scrollWheelEvent2Source:nil,units:.line,wheelCount:1,wheel1:delta,wheel2:0,wheel3:0))}
 else if type=="text"{guard focusedInScope(), let text=input["text"] as? String,!text.isEmpty,text.count<=32,!text.unicodeScalars.contains(where:{$0.value<32 || $0.value==127}) else{stop();return};let chars=Array(text.utf16);for down in [true,false]{let e=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:down);e?.keyboardSetUnicodeString(stringLength:chars.count,unicodeString:chars);post(e)}}
 else if type=="key"{guard focusedInScope() else{stop();return};let keys:[String:CGKeyCode]=["Enter":36,"Backspace":51,"Tab":48,"Escape":53,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126];guard let key=input["key"] as? String,let code=keys[key] else{stop();return};for down in [true,false]{post(CGEvent(keyboardEventSource:nil,virtualKey:code,keyDown:down))}}
 else{stop()}
}
var pending=Data();FileHandle.standardInput.readabilityHandler={h in let data=h.availableData;if data.isEmpty{DispatchQueue.main.async{stop();exit(0)};return};DispatchQueue.main.async {pending.append(data);if pending.count>8192{stop();exit(1)};while let at=pending.firstIndex(of:10){let line=pending.prefix(upTo:at);pending.removeSubrange(...at);guard let value=(try? JSONSerialization.jsonObject(with:line)) as? [String:Any] else{stop();continue};packet(value)}}}
Timer.scheduledTimer(withTimeInterval:0.05,repeats:true){_ in if active  &&  (!safe() || Date()>=deadline || Date()>=expires ||  !CGEvent.tapIsEnabled(tap:tap)){stop()}}
RunLoop.main.run()
