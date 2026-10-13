// Non-elevated, consent-scoped SendInput adapter. No filesystem, process-launch or clipboard commands.
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;
using System.Security.Principal;
class Program {
 const long Tag=0x434c414e5243; static bool active,pressed;static DateTime deadline,expires;static Rectangle area;static readonly object Gate=new();
 [StructLayout(LayoutKind.Sequential)] struct POINT {public int x,y;}
 [StructLayout(LayoutKind.Sequential)] struct MOUSE {public int dx,dy;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] struct KEY {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] struct UNION {[FieldOffset(0)]public MOUSE mouse;[FieldOffset(0)]public KEY key;}
 [StructLayout(LayoutKind.Sequential)] struct INPUT {public uint type;public UNION value;}
 [StructLayout(LayoutKind.Sequential)] struct MS {public POINT pt;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] struct KS {public uint vk,scan,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] struct RECT {public int left,top,right,bottom;}
 delegate IntPtr Hook(int code,IntPtr message,IntPtr data);static Hook mouseHook=Mouse,keyHook=Keyboard;
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr GetModuleHandle(string? name);
 [DllImport("user32.dll")]static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")]static extern uint SendInput(uint n,INPUT[] inputs,int size);
 [DllImport("user32.dll")]static extern IntPtr SetWindowsHookEx(int type,Hook callback,IntPtr module,uint thread);
 [DllImport("user32.dll")]static extern bool UnhookWindowsHookEx(IntPtr hook);
 [DllImport("user32.dll")]static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out RECT rect);
 [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr desktop);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool GetUserObjectInformation(IntPtr h,int index,System.Text.StringBuilder name,uint length,out uint needed);
 [DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll")]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll")]static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int length,out int needed);
 [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr value);
 static void Output(object value){Console.WriteLine(JsonSerializer.Serialize(value));}
 static void Stop(){active=false;if(pressed){Raw(new INPUT{type=0,value=new UNION{mouse=new MOUSE{flags=4,extra=(UIntPtr)Tag}}});pressed=false;}Output(new{stopped=true});}
 static bool SafeWindow(IntPtr w){if(w==IntPtr.Zero)return false;GetWindowThreadProcessId(w,out uint pid);IntPtr p=OpenProcess(0x1000,false,pid),token=IntPtr.Zero;if(p==IntPtr.Zero)return false;try{if(!OpenProcessToken(p,8,out token)||!GetTokenInformation(token,20,out int elevated,4,out _)||elevated!=0)return false;string name=System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;return !new[]{"consent","CredentialUIBroker","LogonUI","winlogon","SystemSettings","Taskmgr"}.Contains(name,StringComparer.OrdinalIgnoreCase);}catch{return false;}finally{if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(p);}}
 static bool Safe(){if(new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))return false;foreach(int k in new[]{0x10,0x11,0x12,0x5b,0x5c})if((GetAsyncKeyState(k)&0x8000)!=0)return false;IntPtr desktop=OpenInputDesktop(0,false,1);if(desktop==IntPtr.Zero)return false;try{var name=new System.Text.StringBuilder(128);if(!GetUserObjectInformation(desktop,2,name,256,out _)||name.ToString()!="Default")return false;}finally{CloseDesktop(desktop);}return SafeWindow(GetForegroundWindow());}
 static bool FocusedInScope(){return GetWindowRect(GetForegroundWindow(),out RECT r)&&area.Contains(Rectangle.FromLTRB(r.left,r.top,r.right,r.bottom));}
 static void Raw(INPUT input){SendInput(1,new[]{input},Marshal.SizeOf<INPUT>());}
 static void Post(INPUT input){if(!active||!Screen.AllScreens.Any(s=>s.Bounds==area)||!Safe()||DateTime.UtcNow>=deadline||DateTime.UtcNow>=expires){Stop();return;}if(SendInput(1,new[]{input},Marshal.SizeOf<INPUT>())!=1)Stop();}
 static IntPtr Mouse(int code,IntPtr message,IntPtr data){if(code>=0&&Marshal.PtrToStructure<MS>(data).extra.ToUInt64()!=(ulong)Tag)lock(Gate){if(active)Stop();}return CallNextHookEx(IntPtr.Zero,code,message,data);}
 static IntPtr Keyboard(int code,IntPtr message,IntPtr data){if(code>=0&&Marshal.PtrToStructure<KS>(data).extra.ToUInt64()!=(ulong)Tag)lock(Gate){if(active)Stop();}return CallNextHookEx(IntPtr.Zero,code,message,data);}
 static void Packet(JsonElement v){string? kind=v.GetProperty("kind").GetString();if(kind=="stop"){Stop();return;}if(kind=="arm"){var rect=v.GetProperty("bounds");var requested=new Rectangle(rect.GetProperty("x").GetInt32(),rect.GetProperty("y").GetInt32(),rect.GetProperty("width").GetInt32(),rect.GetProperty("height").GetInt32());var monitor=Screen.AllScreens.FirstOrDefault(s=>s.Bounds==requested);double seconds=v.GetProperty("seconds").GetDouble();if(active||monitor==null||!Safe()||seconds<=0||seconds>180){Stop();return;}area=monitor.Bounds;expires=DateTime.UtcNow.AddSeconds(seconds);deadline=DateTime.UtcNow.AddSeconds(1);active=true;Output(new{armed=true});return;}if(!active||!Screen.AllScreens.Any(s=>s.Bounds==area)||!Safe()||DateTime.UtcNow>=deadline||DateTime.UtcNow>=expires){Stop();return;}if(kind=="heartbeat"){deadline=DateTime.UtcNow.AddSeconds(1);return;}if(kind!="input"){Stop();return;}var input=v.GetProperty("input");string? type=input.GetProperty("type").GetString();if(type=="pointer"){double x=input.GetProperty("x").GetDouble(),y=input.GetProperty("y").GetDouble();if(!double.IsFinite(x)||!double.IsFinite(y)||x<0||x>1||y<0||y>1){Stop();return;}var point=new POINT{x=area.X+(int)(x*(area.Width-1)),y=area.Y+(int)(y*(area.Height-1))};if(!SafeWindow(WindowFromPoint(point))){Stop();return;}var bounds=SystemInformation.VirtualScreen;Post(new INPUT{type=0,value=new UNION{mouse=new MOUSE{dx=(int)((point.x-bounds.X)*65535L/Math.Max(1,bounds.Width-1)),dy=(int)((point.y-bounds.Y)*65535L/Math.Max(1,bounds.Height-1)),flags=0xC001,extra=(UIntPtr)Tag}}});string? action=input.GetProperty("action").GetString();if(action=="down"||action=="up"){pressed=action=="down";Post(new INPUT{type=0,value=new UNION{mouse=new MOUSE{flags=pressed?2u:4u,extra=(UIntPtr)Tag}}});}else if(action=="click"){foreach(uint flags in new uint[]{2,4})Post(new INPUT{type=0,value=new UNION{mouse=new MOUSE{flags=flags,extra=(UIntPtr)Tag}}});}else if(action!="move")Stop();}
 else if(type=="scroll"){int d=input.GetProperty("delta").GetInt32();if(d < -10 || d > 10 || !GetCursorPos(out POINT cursor) || !area.Contains(cursor.x,cursor.y) || !SafeWindow(WindowFromPoint(cursor))){Stop();return;}Post(new INPUT{type=0,value=new UNION{mouse=new MOUSE{flags=0x800,data=unchecked((uint)(d*120)),extra=(UIntPtr)Tag}}});}
 else if(type=="text"){string text=input.GetProperty("text").GetString()??"";if(text.Length<1||text.Length>64||text.Any(char.IsControl)||!FocusedInScope()){Stop();return;}foreach(char c in text)foreach(uint flags in new uint[]{4,6})Post(new INPUT{type=1,value=new UNION{key=new KEY{scan=c,flags=flags,extra=(UIntPtr)Tag}}});}
 else if(type=="key"){var keys=new Dictionary<string,ushort>{{"Enter",13},{"Tab",9},{"Backspace",8},{"Escape",27},{"ArrowLeft",37},{"ArrowUp",38},{"ArrowRight",39},{"ArrowDown",40}};if(!FocusedInScope()||!keys.TryGetValue(input.GetProperty("key").GetString()??"",out ushort key)){Stop();return;}foreach(uint flags in new uint[]{0,2})Post(new INPUT{type=1,value=new UNION{key=new KEY{vk=key,flags=flags,extra=(UIntPtr)Tag}}});}else Stop();}
 [STAThread]static void Main(string[] args){SetProcessDpiAwarenessContext(new IntPtr(-4));if(args.Contains("--check")||args.Contains("--request")){Output(new{available=Safe(),platform="Windows"});return;}IntPtr mouse=SetWindowsHookEx(14,mouseHook,GetModuleHandle(null),0),keyboard=SetWindowsHookEx(13,keyHook,GetModuleHandle(null),0);if(mouse==IntPtr.Zero||keyboard==IntPtr.Zero){Output(new{error="Native input monitoring unavailable"});return;}var timer=new System.Windows.Forms.Timer{Interval=50};timer.Tick+=(_,_)=>{lock(Gate){if(active&&(!Safe()||DateTime.UtcNow>=deadline||DateTime.UtcNow>=expires))Stop();}};timer.Start();Task.Run(()=>{try{string? line;while((line=Console.ReadLine())!=null){if(line.Length>8192)break;using var d=JsonDocument.Parse(line);lock(Gate)Packet(d.RootElement);}}catch{lock(Gate)Stop();}finally{lock(Gate)Stop();Application.Exit();}});Application.Run();UnhookWindowsHookEx(mouse);UnhookWindowsHookEx(keyboard);}
}
