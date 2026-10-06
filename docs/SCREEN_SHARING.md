# Screen sharing

**Status: not implemented (Milestone 4).** Plan: a bundled, locally managed LiveKit server (no LiveKit Cloud, no
external STUN/TURN), teacher publishes once via `desktopCapturer`/`getDisplayMedia`, students subscribe. Nothing in
this build captures the screen; the Electron permission handler currently denies all media requests.
