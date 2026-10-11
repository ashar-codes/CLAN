# Windows development and test setup

For Claude Code (or a person) working on CLAN on a Windows 10/11 x64 PC. Nothing here has been run on Windows yet —
record what fails in a PR (see [REAL_DEVICE_TESTING.md](REAL_DEVICE_TESTING.md) › Working on branches).

## 1. Tools (PowerShell as your normal user; admin only where noted)

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS -e            # Node 24 or later (package.json engines: node >= 24)
winget install --id Microsoft.DotNet.SDK.8 -e   # only to build the Direct Network helper
winget install --id GitHub.cli -e
corepack enable                                 # admin PowerShell if it fails; gives the pinned pnpm 11.20.0
node -v; pnpm -v; dotnet --version; gh --version
```

Use a checkout path **without spaces** (e.g. `C:\dev\CLAN`): native builds and some scripts don't cope with spaces.

## 2. Clone and install

```powershell
gh auth login --hostname github.com --git-protocol https --web   # sign in as ashar-codes (or an invited collaborator)
mkdir C:\dev; cd C:\dev
gh repo clone ashar-codes/CLAN
cd CLAN
git checkout clan-astra-phase12
pnpm install --frozen-lockfile
```

## 3. Native helpers (git-ignored binaries; packaging fails without them)

```powershell
# Screen-sharing SFU: official LiveKit v1.13.9 Windows release, SHA-256 pinned in native/livekit/fetch.sh
$v = '1.13.9'; $zip = "livekit_${v}_windows_amd64.zip"
Invoke-WebRequest "https://github.com/livekit/livekit/releases/download/v$v/$zip" -OutFile "$env:TEMP\$zip"
(Get-FileHash "$env:TEMP\$zip" -Algorithm SHA256).Hash.ToLower()   # must equal d5b5e44c197f613fdd6bdb2ae53e9d086d848156d43f614c688c6b595cd3f25e
New-Item -ItemType Directory -Force native\livekit\bin\win32-x64 | Out-Null
Expand-Archive "$env:TEMP\$zip" -DestinationPath "$env:TEMP\livekit" -Force
Copy-Item "$env:TEMP\livekit\livekit-server.exe" native\livekit\bin\win32-x64\

# Direct Network helper (C#/.NET 8, self-contained win-x64)
dotnet publish native\windows-direct -c Release -o native\windows-direct\bin\publish
```

(Git Bash alternative for LiveKit: `sh native/livekit/fetch.sh win32-x64`.)

## 4. Check, run, test

```powershell
pnpm typecheck
pnpm test                      # unit suite (324 tests on the RC1 Mac run); report Windows-only failures, don't skip them
pnpm dev                       # desktop app in development mode
pnpm test:e2e                  # desktop E2E (builds first; opens Electron windows)
```

Two instances on one PC (host + member) use separate profiles: `pnpm --filter @classroom/desktop start -- --profile=host`
and `-- --profile=student` after `pnpm build:desktop`. Profiles live under `%APPDATA%\Classroom LAN\profile-<name>`.

## 5. Build the Windows installer on Windows

```powershell
cd apps\desktop
pnpm build
npx electron-builder --win nsis --x64            # icon/version resources applied natively; unsigned without a certificate
# with an Authenticode certificate: $env:CSC_LINK = 'C:\path\cert.pfx'; $env:CSC_KEY_PASSWORD = '...' (never commit them)
Get-FileHash "release\CLAN Setup 0.1.0.exe" -Algorithm SHA256
```

Installers stay local (`release/` is git-ignored). Don't commit or upload them.

## 6. Windows specifics to verify (all UNVERIFIED so far)

* Installer: per-machine, asks for admin, adds three local-subnet inbound rules —
  `netsh advfirewall firewall show rule name="CLAN (local network)"` (and `CLAN discovery …`, `CLAN screen sharing …`).
  Uninstall must remove them.
* Data: `%APPDATA%\Classroom LAN` (database `teacher.db`, keys `keys\*.enc` wrapped with DPAPI). Survives
  update/uninstall.
* Discovery (mDNS UDP 5353), screen sharing (LiveKit UDP), Direct Network helper consent prompts, SmartScreen on the
  unsigned installer, Event Viewer › Windows Logs › Application for crashes.
* Use disposable profiles for experiments: `$env:CLASSROOM_USER_DATA = "$env:TEMP\clan-test-1"` before launching.
