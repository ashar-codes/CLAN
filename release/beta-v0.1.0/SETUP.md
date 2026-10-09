# CLAN v0.1.0 closed beta — setup guide

CLAN works on a local Wi-Fi network only. It needs no account, no internet and no cloud. Check every installer
against `SHA256SUMS` before installing:

```sh
shasum -a 256 -c SHA256SUMS            # macOS / Linux
certutil -hashfile "CLAN Setup 0.1.0.exe" SHA256   # Windows (compare with SHA256SUMS)
```

## macOS (Apple Silicon, macOS 13 or later) — `CLAN-0.1.0-arm64.dmg`
1. Open the DMG and drag **CLAN** to Applications.
2. The beta is **not signed with an Apple Developer ID and not notarized** (ad-hoc signature only). The first open is
   blocked: open CLAN once, then System Settings › Privacy & Security › "CLAN was blocked…" › **Open Anyway**, and confirm.
3. Allow **Local Network** when asked (needed to find and host CLANs). Bluetooth is asked only for Direct Network.
4. Updating: quit CLAN, replace the app in Applications with the new one. Your data stays in
   `~/Library/Application Support/Classroom LAN`. Because the beta is ad-hoc signed, macOS may ask once after an update
   whether CLAN may use its key in your keychain — choose **Always Allow**. If you deny, CLAN can't read its keys and
   starts with a new device identity (teachers/linked devices must approve this computer again); nothing is deleted.
5. Uninstalling: delete CLAN from Applications. Your data stays until you delete the folder above yourself.

Intel Macs: not built for this beta.

## Windows 10/11 (x64) — `CLAN Setup 0.1.0.exe`
> **UNVERIFIED:** this installer was built on macOS and has never been run on Windows. Please report anything that fails.
1. The installer is **not code-signed**: SmartScreen shows "Windows protected your PC" → More info → **Run anyway**.
2. It installs for all users (administrator approval needed) into Program Files and adds three inbound firewall rules,
   limited to your local subnet: CLAN (TCP), CLAN discovery (UDP) and CLAN screen sharing (UDP, `livekit-server.exe`).
3. Your data is in `%APPDATA%\Classroom LAN`, protected by Windows (DPAPI). Uninstall (Settings › Apps) removes the app
   and the firewall rules and keeps your data.

## Android (arm64, Android 7.0+) — `CLAN-0.1.0-android-arm64.apk`
1. Copy the APK to the phone (USB, or any file transfer you trust) and open it in Files; allow "install unknown apps"
   for that app once. The APK is signed with the CLAN beta key (certificate SHA-256
   `98:03:DC:D4:A4:6B:8F:23:76:8E:27:23:2F:47:CE:06:30:D2:0B:D0:94:72:13:1C:C1:79:60:6F:BF:C9:A6:0B`).
2. On first start, enter your name, roll number and a device name. Allow nearby devices / location only if CLAN asks
   while joining a CLAN that runs its own network; allow notifications if you want message alerts.
3. Updating: install the newer APK over the old one. Your data, linked devices and keys stay. An APK signed with a
   different key is refused by Android (that protects your data).
4. **Uninstalling deletes all CLAN data on the phone.** Android backup is off on purpose (the database key is kept in
   the phone's Android Keystore and can't move to another phone), so it can't be restored. Link the phone with your laptop (Me › Open My Devices) first if
   you want to keep your study data.

## iOS
Not available in this beta (see KNOWN_LIMITATIONS.md).

## Using it
* Teacher / host: CLANs → Create CLAN → Classroom (or Study group) → Start. Share the 6-digit code.
* Students: Join a CLAN → code. If the CLAN isn't found automatically, type the address the host shows.
* All devices must be on the same Wi-Fi. Networks with "client isolation" (common guest / public Wi-Fi) block CLAN.

## Feedback
Desktop: Me › Beta feedback → Save feedback… (diagnostics only if you tick them; preview first). Phones: the checklists.
Send the files yourself. CLAN has no telemetry and uploads nothing.
