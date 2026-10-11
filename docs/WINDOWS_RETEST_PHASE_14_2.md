# Phase 14.2 native Windows retest

Status: **NOT TESTED on Windows**. Source fixes `fd8249c` and `a833dd1` are on `phase-14.2`; handoff baseline is `4a7dcaa`. This procedure requires a real Windows 10/11 PC plus a Mac and Android device on the same LAN. Use disposable profiles on every device. Do not clear a personal Android installation or replace signing keys.

## Windows Codex: checkout and verify

In the existing clean test checkout (preserve any dirty checkout by using a separate worktree):

```powershell
git fetch https://github.com/ashar-codes/CLAN.git phase-14.2
git switch --create win/phase-14.2-retest FETCH_HEAD
git status --short
git rev-parse HEAD
node -v
pnpm -v
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test --no-file-parallelism --maxWorkers=1
Get-NetConnectionProfile
```

Record the full commit hash. If the branch already exists, inspect its status and use it only when it contains the same source commit. Do not force checkout or reset. Use Node 24+ and pinned pnpm 11.20.0; native helper setup is in [WINDOWS_SETUP.md](WINDOWS_SETUP.md).

For a trusted test LAN, the owner may select the Private profile in Windows Settings. Let Windows show its firewall prompt and allow the app on **Private networks**. Never disable the firewall or TLS verification. A Public profile or client-isolated guest network is a configuration finding, not evidence that join works.

```powershell
$env:CLASSROOM_USER_DATA = Join-Path $env:TEMP ('clan-142-host-' + [guid]::NewGuid())
$env:CLAN_DEBUG_DISCOVERY = '1'
pnpm dev
```

Create a **Classroom**, start LAN hosting, and record the adapter name and host address displayed by CLAN. With WSL/Hyper-V/VMware installed, confirm the selected address belongs to the real LAN adapter. Keep join codes and bearer tokens out of committed evidence.

## Mac and Android join

Use the **same recorded source commit** on the Mac with a disposable `CLASSROOM_USER_DATA`. Build the Android release from that commit using the existing signing identity (`NO_INSTALL=1 apps/mobile/scripts/android-dev.sh --prebuild --release`); verify the APK hash/certificate before installing on a dedicated test phone. Record whether Android testing uses an emulator or a physical phone.

1. Discover the Windows Classroom without typing its address. Enter the code, then approve on Windows. Verify both Mac and Android reach the room.
2. Exchange chat in both directions; Windows sends a file and both devices download it with matching SHA-256. Add whiteboard text on Android with the keyboard open; verify one persisted object on the host and Mac.
3. Disconnect/reconnect each member's network. Restart the Windows host, host the existing CLAN again, and rejoin using the supported device-key flow. Verify messages/files/whiteboard remain accessible and no unauthorized member is approved.
4. Repeat with an explicitly entered real Windows LAN address. Record discovery and manual-address outcomes separately.
5. Remove/block a disposable member and verify its requests are refused. Repeat a short session with the router's internet uplink unavailable while LAN stays available.
6. Run `pnpm test:e2e` on Windows. Record every failure and skip, including native helper availability. This supplements the physical cross-device test; it does not replace it.

## If join fails

On Windows, inspect locally (sanitize before sharing; omit MAC addresses, unrelated interfaces, DNS suffixes, device names and any secrets):

```powershell
ipconfig /all
Get-NetConnectionProfile
Get-NetFirewallRule | Where-Object DisplayName -Match 'Electron|CLAN' |
  Select-Object DisplayName, Enabled, Direction, Action, Profile
Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
```

On the Mac, replace the placeholders with the **plaintext bootstrap** address displayed by Windows:

```sh
curl --connect-timeout 5 --max-time 10 http://WINDOWS_LAN_IP:BOOTSTRAP_PORT/api/info
```

This route is the unauthenticated discovery probe only; do not use `curl -k` for authenticated APIs. Record whether it times out, is refused, or returns the expected session ID. Capture the sanitized Mac `CLAN_DEBUG_DISCOVERY=1` `browse up {url, alt}` line and error kind. An answering probe still requires OPAQUE, pinned TLS and host approval.

## Return evidence

Add `design/hardware/YYYY-MM-DD-windows-14.2.md` on `win/phase-14.2-retest`: full source commit, Windows version, network class/client isolation, selected adapter, Mac/Android model and OS, APK hash/certificate, commands and counts, plus PASS/FAIL/NOT TESTED for discovery join, manual join, chat, file hash, whiteboard, reconnect, host restart and revocation. No installer, database, raw log or private data belongs in Git. Share the evidence commit/PR with Mac Codex; do not merge or push to integration/release tags automatically.


### Latest Phase 14.2 follow-up

Fetch/pull only `phase-14.2`, record `git rev-parse HEAD`, and retain an isolated disposable test profile. In addition to
join/file actions, verify native chat scrolling, Classroom approval policy, archive/leave and stored-copy removal after
leave, plus host Raise Hand acknowledgment. End a local host before deleting its CLAN; verify cancel and last-copy
warning, retry after failure, private notes and unrelated files retained. Test each platform using the actual tested
source commit; earlier source-only/Mac/emulator results do not make Windows PASS. Return tested SHA, host/client OS,
join/approval/reconnect results and sanitized errors. No public distribution or signing identity changes authorized.
