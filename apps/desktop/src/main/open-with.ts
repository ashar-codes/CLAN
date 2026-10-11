import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

// Documented SHOpenWithDialog, executed without elevation or an execution-policy bypass.
// The filename is an environment value; it is never interpolated into PowerShell/C# source.
const WINDOWS_CHOOSER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClanViewer {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct OpenAs { [MarshalAs(UnmanagedType.LPWStr)] public string file; [MarshalAs(UnmanagedType.LPWStr)] public string type; public uint flags; }
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern int SHOpenWithDialog(IntPtr parent, ref OpenAs info);
}
'@
$info = New-Object ClanViewer+OpenAs
$info.file = $env:CLAN_VIEW_FILE
$info.type = $null
$info.flags = 4
$result = [ClanViewer]::SHOpenWithDialog([IntPtr]::Zero, [ref]$info)
if ($result -lt 0 -and $result -ne -2147023673) { throw 'Windows could not open the viewer chooser.' }
`;
export async function windowsOpenWith(path: string) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error('Windows system directory is unavailable.');
  await promisify(execFile)(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand', Buffer.from(WINDOWS_CHOOSER, 'utf16le').toString('base64')],
    { env: { ...process.env, CLAN_VIEW_FILE: path }, windowsHide: true });
}
