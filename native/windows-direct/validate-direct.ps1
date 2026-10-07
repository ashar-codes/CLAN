<#
  CLAN Direct Network — Windows validation (run on real hardware, normal user, PowerShell 7+).
  1) builds/publishes the helper, 2) records the machine, 3) runs probe/start/status/stop UNPACKAGED,
  4) registers the sparse package (identity) and repeats, 5) checks firewall rules, 6) writes results JSON.
  Nothing here touches netsh hosted network. Requires: .NET 8 SDK; for step 4: Windows SDK (makeappx, signtool), admin once.
  Usage:  ./validate-direct.ps1 [-NoIdentity] [-Band auto|2.4|5]
#>
param([switch]$NoIdentity, [ValidateSet('auto','2.4','5')][string]$Band = 'auto')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pub = Join-Path $root 'bin\publish'
$results = [ordered]@{ startedAt = (Get-Date).ToString('o') }

dotnet publish $root -c Release -o $pub | Out-Null
$exe = Join-Path $pub 'CLAN.DirectHelper.exe'

# --- machine facts -------------------------------------------------------------------------------------------------
$os = Get-CimInstance Win32_OperatingSystem
$wifi = Get-NetAdapter -Physical | Where-Object { $_.NdisPhysicalMedium -eq 9 -or $_.InterfaceDescription -match 'Wi-?Fi|Wireless|802\.11' }
$results.machine = [ordered]@{
  windows = "$($os.Caption) $($os.Version) build $($os.BuildNumber)"
  wifiAdapters = @($wifi | ForEach-Object { [ordered]@{ name = $_.Name; description = $_.InterfaceDescription; driver = $_.DriverVersion; driverDate = $_.DriverDate; status = $_.Status } })
  wlanDriver = (netsh wlan show drivers | Select-String 'Driver|Vendor|Version|Radio types|Wi-Fi Direct' | ForEach-Object { $_.Line.Trim() })
  internet = (Test-NetConnection -ComputerName 1.1.1.1 -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue)
  bluetooth = @(Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 3 -ExpandProperty FriendlyName)
}

function Invoke-Helper([string]$label) {
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = New-Object System.Diagnostics.ProcessStartInfo $exe
  $p.StartInfo.RedirectStandardInput = $true; $p.StartInfo.RedirectStandardOutput = $true; $p.StartInfo.UseShellExecute = $false
  [void]$p.Start()
  $call = { param($o) $o.id = [guid]::NewGuid().ToString(); $p.StandardInput.WriteLine(($o | ConvertTo-Json -Compress -Depth 5))
    while ($true) { $l = $p.StandardOutput.ReadLine(); if ($null -eq $l) { return $null }; $m = $l | ConvertFrom-Json; if ($m.id -eq $o.id) { return $m } } }
  $r = [ordered]@{ label = $label }
  $r.probe = & $call @{ cmd = 'probe' }
  $strategy = if ($r.probe.result.legacy.available) { 'wifi-direct-legacy' } elseif ($r.probe.result.hotspot.available -and $r.probe.result.hotspot.upstream) { 'mobile-hotspot' } else { $null }
  $r.strategy = $strategy
  if ($strategy) {
    $ssid = 'CLAN-' + -join ((48..57 + 65..72 + 74..78 + 80..90) | Get-Random -Count 4 | ForEach-Object { [char]$_ })
    $pass = -join ((50..57 + 65..72 + 74..78 + 80..90 + 97..107 + 109..110 + 112..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r.start = & $call @{ cmd = 'start'; strategy = $strategy; ssid = $ssid; passphrase = $pass; band = $Band }
    $r.startMs = $sw.ElapsedMilliseconds
    $r.ssidVisible = [bool](netsh wlan show networks | Select-String $ssid)  # from this PC's own scan (may be false for its own AP)
    $r.status = & $call @{ cmd = 'status' }
    Write-Host "`n>>> $label : network $ssid is up. Join it from a second device now (password printed below), then press Enter."
    Write-Host "    password: $pass"; [void](Read-Host)
    $r.statusWithClient = & $call @{ cmd = 'status' }
    $r.firewallAdd = & $call @{ cmd = 'firewall.add'; rules = @(@{ name = "CLAN Direct $([guid]::NewGuid()) https"; program = $exe; protocol = 'TCP'; localPort = 47123; remote = 'LocalSubnet'; interfaceType = 'Wireless' }) }
    $r.firewallRules = @(Get-NetFirewallRule -DisplayName 'CLAN*' -ErrorAction SilentlyContinue | Select-Object DisplayName, Enabled, Direction, Action, Profile)
    $r.firewallRemove = & $call @{ cmd = 'firewall.remove'; prefix = 'CLAN Direct ' }
    $r.stop = & $call @{ cmd = 'stop' }
    Start-Sleep -Seconds 3
    $r.statusAfterStop = & $call @{ cmd = 'status' }
  }
  $p.StandardInput.Close(); $p.WaitForExit(5000) | Out-Null
  return $r
}

$results.unpackaged = Invoke-Helper 'unpackaged'

if (-not $NoIdentity) {
  # Sparse package (identity for the external exe). Self-signed for validation only.
  $pkgDir = Join-Path $root 'package'; $msix = Join-Path $pub 'CLAN.DirectHelper.sparse.msix'
  Copy-Item "$env:WINDIR\System32\SecurityAndMaintenance.png" (Join-Path $pkgDir 'logo.png') -ErrorAction SilentlyContinue
  $sdk = (Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" | Sort-Object FullName -Descending | Select-Object -First 1).DirectoryName
  & "$sdk\makeappx.exe" pack /d $pkgDir /p $msix /nv /o | Out-Null
  $cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=CLAN Validation' -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  & "$sdk\signtool.exe" sign /fd SHA256 /sha1 $cert.Thumbprint $msix | Out-Null
  Write-Host 'Trusting the validation certificate needs admin once (LocalMachine\TrustedPeople).'
  Export-Certificate -Cert $cert -FilePath (Join-Path $pub 'clan-validation.cer') | Out-Null
  Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -Command Import-Certificate -FilePath '$(Join-Path $pub 'clan-validation.cer')' -CertStoreLocation Cert:\LocalMachine\TrustedPeople"
  Add-AppxPackage -Path $msix -ExternalLocation $pub
  $results.withIdentity = Invoke-Helper 'package-identity'
  Get-AppxPackage CLAN.DirectHelper | Remove-AppxPackage
}

$out = Join-Path $root "validation-$(Get-Date -Format yyyyMMdd-HHmmss).json"
$results | ConvertTo-Json -Depth 8 | Set-Content $out
Write-Host "`nResults: $out  — attach to docs/WINDOWS_DIRECT_MODE.md (Validation log)."
