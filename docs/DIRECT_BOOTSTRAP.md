# Direct bootstrap: from six digits to the host's Wi-Fi

The member only types the six-digit code. Before any Wi-Fi exists between them, host and member talk over **BLE**; the BLE
link carries only the existing OPAQUE pairing messages.

```
member                                   host (Direct network up, not yet joined)
scan BLE service 6f1a0001-…  ──────────► advertises service UUID + random tag (no name, course, code)
hello                        ──────────► { sessionId }                      (untrusted hint, like mDNS)
OPAQUE start (KE1)           ──────────► KE2                               (same Pairing + throttles as HTTP)
OPAQUE finish (KE3)          ──────────► TLS binding (HMAC, OPAQUE key) + direct = AES-256-GCM(OPAQUE-derived key,
                                          { ssid, passphrase, host, bootstrapPort, expiresAt }, AAD = session + pairing)
verify binding, open package → join Wi-Fi (OS dialog if any) → pinned HTTPS to host:httpsPort → join proof (MAC + Ed25519)
```

* **Code ≠ Wi-Fi key.** The code is only the OPAQUE password. The Wi-Fi passphrase is 24 random characters (~139 bits), fresh
  every session; the SSID is `CLAN-XXXX` (random).
* **Release only after OPAQUE.** A wrong code yields no package (OPAQUE fails first); the package key is HKDF-derived from the
  OPAQUE session key (`derivePairingKeys().direct`), cipher AES-256-GCM (`@noble/ciphers`). Bound to session + pairing id,
  single-use pairing, expires (≤ 10 min). Replays, tampering and re-targeting fail (tests in `server/test/direct.test.ts`).
* **BLE leaks nothing secret**: frames are OPAQUE messages and ciphertext (test: a recording relay never sees the code, the
  passphrase or the host's name). A fake BLE host can't finish OPAQUE without the code; with several hosts nearby the code picks.
* **Rate limits**: BLE connections rotate, so per-source limits are weaker; the CLAN-wide limit (50 failures/min) still bounds
  guessing.
* **Wi-Fi ≠ membership.** Anyone with the passphrase only reaches the plaintext OPAQUE bootstrap and pinned HTTPS; without the
  code they get nothing (test).

## QR fallback
Host → “Show QR to join”: `clan://direct#<base64url package>` (network only; **no code**), expires in ≤ 30 min and with the
session. Scanned by the phone camera, opens CLAN, joins the Wi-Fi, then the member enters the code as usual.

## Manual fallback (last resort)
If the platform can't join Wi-Fi automatically, the member sees the network name and a copy button for the password — only
after OPAQUE succeeded (or from the host's QR).

## Platforms
| Member platform | BLE bootstrap | Joining the Wi-Fi |
|---|---|---|
| Windows | helper (`BluetoothLEAdvertisementWatcher`, GATT client) — compiles, unverified | helper `WiFiAdapter.ConnectAsync` (Windows Wi-Fi access prompt) — unverified |
| macOS | `native/macos-ble` (CoreBluetooth) — compiles; needs the app bundle's Bluetooth permission | `networksetup -setairportnetwork` (execFile, validated args) — unverified |
| iOS | `DirectBle.swift` — type-checked on macOS SDK | `NEHotspotConfiguration` (user confirms; entitlement) — not compiled here (no iOS SDK) |
| Android | Kotlin `BluetoothLeScanner`/GATT — not compiled here (no Android SDK) | `WifiNetworkSpecifier` + `bindProcessToNetwork` (Android 10+; older → manual) — not compiled |
Bluetooth off / denied / unsupported → no BLE carriers; LAN discovery, QR and manual still work.
