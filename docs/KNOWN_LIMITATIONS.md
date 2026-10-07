# Known limitations (current build)

* Milestones 0–2 exist. No screen sharing, presentation, chat, quizzes, whiteboard, exam mode, in-app archive browser yet.
* One file per submission (students zip multiple files). Group submissions are modelled (`mode: 'group'`) but rejected until groups exist.
* Mobile uploads restart from byte 0 on retry (still idempotent); desktop resumes from the server offset.
* Teacher app restart starts a new session; in-progress uploads from the old session are marked failed. Resources are per session (re-add files to a new class).
* Downloads are served by the teacher only (no peer redistribution); throughput is bounded by the teacher's Wi-Fi link.
* Download progress shown to the teacher is self-reported by students.
* Strict Range handling: multi-range or malformed `Range` headers get 416 rather than a full 200.
* LAN traffic (including files and submissions) is unencrypted; device identity is a UUID, not a key; receipts are unsigned (SECURITY.md).
* Direct Mode: not implemented on Windows yet; impossible through supported APIs on macOS.
* Networks with client isolation cannot work in LAN Mode.
* Session tokens are in memory: restarting the student app means re-entering the code (an already-approved device is
  let back in without re-approval).
* If two classrooms on one LAN ever share a code (1-in-a-million per pair), the student joins whichever answers first.
* Mobile and Windows builds have not been executed on real devices/OS from this machine.
