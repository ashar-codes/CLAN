# Final product audit

Baseline: BTC-2R.1 `4cff48d` (branch `btc-2r1-qa-packages`). Work branch: `final-clan-polish`.
Existing user data, identities, signing material, installed apps and BTC-1/BTC-2R installers were not modified;
all testing used disposable profiles and separately identified QA apps (`*.finalqa`, "CLAN QA").

## Findings → changes

| Area | Finding (root cause) | Change |
|---|---|---|
| New devices not finding each other | Strangers are discovered only via Everyone Nearby, which was off by default and expired after 1 h | Everyone Nearby is the default for **new** people and persists; temporary mode is an explicit choice; saved choices kept |
| Wrong names (“CLAN user”) | Phones never copied the onboarding name into the People profile | `adoptIdentity` on start and profile save; placeholder never advertised |
| Personal/demo data | “Ashar Khan”, “Ashar-MacBook/iPhone” placeholders; personal names in tests | Generic placeholders; neutral test fixtures |
| No desktop first run | People silently invisible until a join form was filled | Desktop onboarding (name + device required, ID/picture optional, visibility choice) |
| Roll number required | Blocked using People without academic info | Optional; asked only when joining a CLAN |
| No device names | — | Carried in the authenticated link hello; shown as secondary label |
| Chat UX | Basic list of cards and buttons | Header with device + call/video/⋮, date separators, grouped bubbles, ticks, long-press + chevron sheets, reply/edit/forward/react/copy/info/delete, search, unread badges |
| Edit / delete | Not available | Signed author-only `msg.edit` / `msg.delete` with windows, ordering, tombstones, offline queue, honest failure |
| File consent / export | Always manual accept; no Gallery save | Optional friend-only bounded auto-download; verified Save to Gallery/Photos and Save to Files |
| Background delivery | LAN-only; OS suspends apps | Optional FCM/APNs/PushKit wake-up architecture with relay (not deployed); call ringing via wake-up |
| Notifications | Generic “CLAN” text; blank Android icon | Sender names (when previews allowed); monochrome logo icon; LAN/push dedupe |
| CLAN discovery on phones | zeroconf errors silently swallowed, no restart | Backoff restart, foreground restart, visible status |
| Code-connected card jumping | Card switched lists when the person was also discovered | Stable placement |
| QR scanner | Camera permission re-requested in a loop after “Don’t allow” | Ask once per opening |
| Android keyboard | Composer hidden under the keyboard (edge-to-edge) | Padding keyboard avoidance; tab bar hidden while typing |
| Icons | Default/none | All platforms generated from `assets/brand/clan-logo.png` |
| iOS native build | Never fully compiled in earlier phases | Device build succeeds; Hermes prebuilt pinned & verified |

Everything above is covered in the topic documents:
FINAL_PROFILE_DISCOVERY.md, FINAL_CHAT_FILE_SHARING.md, FINAL_ANDROID_FCM.md, FINAL_IOS_PUSH_CALLKIT.md,
FINAL_COMMUNICATION_ARCHITECTURE.md, FINAL_SECURITY_REVIEW.md, FINAL_CROSS_PLATFORM_VERIFICATION.md,
FINAL_RELEASE_BLOCKERS.md.

## Cleanup notes

No stable architecture was rewritten. Removed: placeholder identity defaults, a silent error swallow in phone CLAN
discovery, the permission-request loop. Kept: historical verification documents, protocol identifiers
(`classroomlan`, `Classroom LAN` storage directory) for compatibility. Known remaining polish: first mount of
People › Nearby takes a few seconds on the emulator while discovery starts.
