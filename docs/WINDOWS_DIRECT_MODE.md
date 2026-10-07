# Windows Direct Mode (CLAN Direct Network)

**Status: implemented end-to-end against a deterministic mock backend; the Windows helper compiles against the Windows
10.0.26100 SDK projections. Real Windows radios, drivers and clients: UNVERIFIED (no Windows hardware available).**

## Microsoft API findings (checked 2026-10-08, learn.microsoft.com)
| API | Min Windows | Capability | Finding |
|---|---|---|---|
| `WiFiDirectAdvertisementPublisher` + `Advertisement.LegacySettings` (`IsEnabled`, `Ssid`, `Passphrase`) | Windows 10 (10240) | none listed | Starts a Wi-Fi Direct group owner that ordinary Wi-Fi clients join (“legacy mode”). Docs: “does not serve as a general-purpose Wi-Fi access point”. **No upstream/internet needed.** Stops working if Mobile Hotspot starts (hotspot takes precedence). |
| `NetworkOperatorTetheringManager` (`CreateFromConnectionProfile`, `StartTetheringAsync`, `ClientCount`) | Windows 10 | `wiFiControl` | Created **from a connection profile**; Microsoft’s sample requires the internet profile. Offline use is only possible with unsupported workarounds (fake connectivity checks, loopback adapters). |
| `NetworkOperatorTetheringSessionAccessPointConfiguration` (+ `StartTetheringAsync(config)`) | Windows 11 24H2 (26100), UniversalApiContract 19 | `wiFiControl` | Per-session SSID/passphrase/band/auth without touching the user’s hotspot settings. |
| Hosted Network (`netsh wlan … hostednetwork`) | — | — | Deprecated, missing on most drivers. **Not used.** |
| Package identity | — | — | Restricted WinRT capabilities (`wiFiControl`) generally need package identity; an unpackaged helper may be refused. Plan: ship the helper with identity (MSIX / sparse package) if the unpackaged run fails. UNVERIFIED. |

## Strategy (runtime selection, `chooseStrategy`)
1. **Wi-Fi Direct legacy AP** whenever available — the only option that satisfies the zero-internet requirement.
2. **Mobile Hotspot (per-session config)** only if legacy is unavailable *and* the PC has an upstream connection (it would also
   share that internet with members). Without an upstream: Direct is reported unavailable with the reason.
Probe: Wi-Fi adapter present, Wi-Fi Direct API present (real group-owner support is confirmed only when `Start()` succeeds),
hotspot capability for the current profile, supported bands, Bluetooth state. The UI shows “Unavailable on this device — Why?”.

## Helper (`native/windows-direct`, C# .NET 8, `CLAN.DirectHelper.exe`)
JSON lines over stdio. Fixed commands, validated in TypeScript (`HelperRequest`) **and** again in C#:
`probe, start, status, stop, firewall.add, firewall.remove, wifi.connect, ble.advertise, ble.stop, ble.notify, ble.scan,
ble.connect, ble.write, ble.close`. No arbitrary commands, no shell. Build on Windows:
`dotnet publish native/windows-direct -c Release -o native/windows-direct/bin/publish` (bundled as an extra resource).
The host address is read from the “Wi-Fi Direct Virtual Adapter” (both strategies surface there).

## Binding, firewall, VPN
* The CLAN server binds **only** the Direct interface address returned by the helper (not 0.0.0.0, not LAN/VPN/WAN).
* Installer (elevated): one inbound rule — program `CLAN.exe`, TCP, `remoteip=localsubnet`; removed on uninstall.
  Runtime (if elevated): per-session rules `CLAN Direct <session> bootstrap|https|peer` — program + port + LocalSubnet + Wireless
  interfaces only; removed at session end and on next launch after a crash. Never allow-all.
* VPN: interfaces matching VPN patterns / CGNAT are listed; the host is warned. Direct traffic stays on the link-local Direct
  subnet, but a full-tunnel VPN that blocks LAN access can still break joining (warning tells the host to pause it).

## Lifecycle
Start: probe → fresh credentials → AP up → server bound to it → firewall → BLE bootstrap → QR available. Stop: BLE down → AP down
(credentials die with it) → rules removed → state file deleted. Crash: `direct-state.json` (no passphrase) → next launch stops
the AP and removes rules. Sleep/resume: same SSID/passphrase restarted; members reconnect with their device keys.

## Validation package (run on real Windows)
`native/windows-direct/validate-direct.ps1` (PowerShell 7, .NET 8 SDK; Windows SDK + one admin prompt for the identity step):
1. `dotnet publish` the helper → `bin/publish/CLAN.DirectHelper.exe` (self-contained win-x64; the same artifact also builds on
   macOS/Linux with `EnableWindowsTargeting`, 94 MB self-contained single file, PE32+ x86-64).
2. Records Windows build, Wi-Fi adapter + driver version/date, `netsh wlan show drivers` (read-only), internet reachability, Bluetooth.
3. **Unpackaged run**: probe → start (fresh `CLAN-XXXX` + random passphrase) → status → pause for a second device to join →
   status → one scoped firewall rule add/list/remove → stop → status (network must be gone).
4. **Package-identity run**: builds/signs/registers the sparse package `package/AppxManifest.xml` (`wiFiControl`, `bluetooth`,
   `location`, `runFullTrust`, external location = the publish dir) and repeats step 3; then unregisters it.
5. Writes `validation-<date>.json` (gitignored); copy the relevant rows into the log below.
Then the app-level test: disconnect Ethernet/Wi-Fi upstream → CLAN → existing Study Group → Host again → Direct Network →
member joins with the code (BLE) / QR → approve → file → End → SSID gone. Repeat at 1/5/10/15/20 members with
`tools/sim/lan-bench.ts --mode classroom` for 1/10/100 MB.

## Validation log
| Date | Windows / adapter / driver | Backend | Identity | Zero-internet | Clients | Result |
|---|---|---|---|---|---|---|
| — | **no Windows hardware available yet** | — | — | — | — | UNVERIFIED |

## Not verified / limits
Real AP start, client association (Windows/macOS/iOS/Android), member↔member reachability on Wi-Fi Direct, client counts,
stability, throughput, package-identity requirement. No client-count claim is made; Existing LAN stays the recommended mode
for large classes.
