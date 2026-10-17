# Screen sharing: root cause of "Screen capture was not allowed"

Branch `fix/screen-sharing-and-presentation-ux`.

## Symptom
Pressing **Present → Share this screen** in the installed CLAN QA app showed "Screen capture was not allowed." even though
Screen Recording was enabled for CLAN QA in System Settings.

## Reproduction on the installed app (macOS 26, `/Applications/CLAN QA.app`, disposable profile, launched with `open`)
| Stage | Result |
|---|---|
| `systemPreferences.getMediaAccessStatus('screen')` | `granted` |
| `desktopCapturer.getSources` (screens + windows, thumbnails) | 1 screen + 9 windows, real thumbnails — the OS grant works |
| `media:choose` (the explicit pick) | accepted |
| `navigator.mediaDevices.getDisplayMedia` | **`NotAllowedError: Permission denied`** |

So the operating system was not refusing anything. The refusal came from inside CLAN.

## Cause (proven with a minimal Electron 44.5.1 reproduction)
In Electron 44, a `getDisplayMedia` call first goes to the session **permission request handler** as permission `media`
with **empty `mediaTypes`**. It does not arrive as `display-capture`, which is what CLAN expected:

```
REQ media {"mediaTypes":[],"isMainFrame":true,...}
RESULT ERR NotAllowedError: Permission denied        ← handler as shipped
```

CLAN's handler (`apps/desktop/src/main/main.ts`) granted `display-capture`. It granted `media` only with a non-empty list of
device types, and only while the microphone or camera was armed. The screen request was therefore refused before
`setDisplayMediaRequestHandler` even ran. The renderer then turned every error into the same generic text (`Presentation.tsx`,
`start()` and `switchTo()`).

The same handler served **meeting screen sharing** (`Meeting.tsx`) and **Study Tape screen recording**
(`tape/recorder.tsx`), so all three were broken on macOS and Windows. Every automated screen test used the development-only
test pattern (`CLAN_TEST_CAPTURE=1`), which never calls `getDisplayMedia`, so the defect never reached a test.

With the request allowed, the same reproduction delivers a live 3024×1964 `monitor` track:
```
REQ media {"mediaTypes":[]}  → DISPLAY HANDLER {"video":true,"audio":false}  → RESULT OK live {displaySurface:"monitor",width:3024,height:1964}
```

## Fix
- **Permission handler:** `media` with no device types (and `display-capture`) is granted **only while a user's explicit
  pick is pending** (`displayArmed()`: a source chosen in CLAN's picker, valid for 30 s, used up by the next capture). The
  display-media handler still hands over exactly that source, or nothing. The microphone and camera rules are unchanged.
  The renderer still cannot capture silently: a forged source id is refused, and so is `getDisplayMedia` without a pick
  (`e2e/screen.test.ts`).
- **Observability:** the main process records the stages of the last attempt: picked, permission asked and granted,
  handler ran, source found, kind. It also records the platform, OS version, Electron version, packaged or development build,
  and the OS permission status (`media:diagnostics`). Source names, window titles and thumbnails are never recorded.
- **Real errors:** `classifyCapture` (`world/media/captureError.ts`) maps the actual error name and message, together
  with those stages, to: permission off, restart/re-toggle, source gone, choice expired or cancelled, capture start failed,
  host refused, presentation server unreachable, publish failed. The permission message appears only when the OS status
  says so. The UI offers Try again, Open Screen Recording settings (macOS), Copy diagnostics and Dismiss. The picker has
  Refresh. A failed capture never sends `present.start`, so no presentation is shown as active.
- **Meeting share and a hidden window:** meetings used to stop a deliberately shared screen when the CLAN window became
  hidden, for example when minimized to show slides. The camera still turns off when the window is hidden. The chosen
  screen share now keeps running.

## macOS permission identity (still applies)
QA builds are **ad-hoc signed**, so macOS ties the Screen Recording grant to that exact build. After installing a new DMG,
the toggle in System Settings can still show "on" while the new build is refused. Turn **CLAN QA** off and on again in
Privacy & Security › Screen & System Audio Recording, then quit and reopen CLAN. CLAN now detects this case and says so;
it no longer reports a generic denial. A Developer ID–signed release keeps the grant across updates (FINAL_RELEASE_BLOCKERS #10).
CLAN never resets TCC or changes privacy settings itself.
