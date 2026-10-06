# Known limitations (current build)

* Only Milestones 0–1 exist. No files, screen sharing, presentation, chat, quizzes, whiteboard, exam mode, archive.
* LAN traffic is unencrypted; device identity is a UUID, not a key (SECURITY.md).
* Direct Mode: not implemented on Windows yet; impossible through supported APIs on macOS.
* Networks with client isolation cannot work in LAN Mode.
* Session tokens are in memory: restarting the student app means re-entering the code (an already-approved device is
  let back in without re-approval).
* If two classrooms on one LAN ever share a code (1-in-a-million per pair), the student joins whichever answers first.
* Mobile and Windows builds have not been executed on real devices/OS from this machine.
