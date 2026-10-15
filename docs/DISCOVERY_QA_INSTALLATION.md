# Discovery-fix QA: installation, physical tests, diagnostics

Packages are in `~/Desktop/CLAN - Discovery Fix QA/` (see its BUILD-MANIFEST.md for the source commit and hashes).

## Install (safe upgrade of the QA app only)
The packages keep the **CLAN QA** identity of the previous final QA build, so they upgrade that QA app in place and
keep its QA data. Your regular CLAN app, BTC builds, their profiles and identities are never touched.

| Platform | File | How |
|---|---|---|
| macOS | `CLAN-macOS-DISCOVERY-QA.dmg` | Drag CLAN QA to Applications (replace). First launch: right-click › Open. Allow **Local Network**. |
| Windows | `CLAN-Windows-DISCOVERY-QA.exe` | Run the installer (SmartScreen › More info › Run anyway). Allow the firewall prompt on **Private** networks. |
| Android | `CLAN-Android-DISCOVERY-QA.apk` | Install over CLAN QA (same signature keeps data). LAN-only build — no Firebase configured. |

iPhone is out of scope for this phase.

## Physical discovery test (15 minutes)
Use two or three devices on the **same Wi‑Fi** (not a guest network). Record PASS/FAIL and the time you waited.

1. **Fresh ↔ fresh**: on a device without CLAN QA data, install, complete onboarding, stay on Home. On the other
   device open People › Nearby. Expected within ~5 s: the new person appears with their real name. Tap Add friend →
   the other side gets the request → accept. No QR needed.
2. **Order**: repeat with the Android app opened *before* the Mac/Windows app, and *after*.
3. **Live CLAN**: on Mac or Windows, Create CLAN → start it. On Android, People › Nearby › **CLAN Radar** (or Join)
   → it appears within ~5 s. Join with the 6-digit code → the host sees the approval request → approve.
4. **Wrong code** → “No CLAN here matches that code” (not “no CLAN found”).
5. **Privacy**: set one device to Friends Only → strangers stop seeing it; Invisible → disappears for everyone.
   Blocking stops requests and messages (in Everyone Nearby you remain visible like to any stranger).
6. **Restart**: close and reopen CLAN QA → same identity, friends reconnect automatically.
7. **Network change**: turn Wi‑Fi off/on, or switch access point/router → within ~10 s the people reappear.
8. **No internet**: unplug the router's internet (LAN only) → discovery and chat keep working.
9. **Different routers/APs** (only if your network routes between them): discovery may not cross routers; use the QR
   or the internal directory. Report what you saw.
10. **Blocked multicast / guest Wi‑Fi**: expected: nothing is discovered, diagnostics says why, QR/host address works.

## Collect diagnostics (if anything fails)
- **Android**: People › Nearby › Connectivity diagnostics › **Refresh discovery**, wait 10 s, then **Share
  diagnostics** and send the text file.
- **Mac/Windows**: People › Nearby › Connectivity diagnostics › Refresh discovery, then **Export diagnostics…**.

Reports contain the stage states (network, listener, announcing, browsing, counts), failure categories and timestamps
— no keys, codes, invites, messages, file names or contact names.

What the categories mean: `no-network` (no LAN address) · `permission` · `listener` · `advertise` (announcement
refused) · `browse` · `resolve` (heard but no address) · `unreachable` (found but TCP blocked: isolation/firewall) ·
`hidden-or-refused` (privacy, expected) · `auth` (identity check failed, not trusted) · `isolated`.
