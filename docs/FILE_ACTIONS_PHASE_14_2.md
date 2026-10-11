# Phase 14.2 file actions

Files stay behind the existing authenticated resource and download interfaces. Preview, Open With and Save use
session/resource IDs; desktop renderers cannot supply filesystem paths. Every action verifies the recorded SHA-256.
Preview supports bounded plain text (256 KiB) and PNG/JPEG (8 MiB, bounded dimensions); other files show a reason.
Text is rendered as text, never HTML. Images require valid headers and bounded dimensions; animated PNG is excluded.
There is no embedded PDF, Office, HTML, SVG or executable viewer.

Open With retains the existing safe extension allowlist. macOS selects an installed application; Windows uses
[SHOpenWithDialog](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shopenwithdialog)
through a fixed native wrapper, passing the filename separately from code. Windows execution remains NOT TESTED.
Android uses a private FileProvider content URI and a temporary read grant, following
[Android file sharing guidance](https://developer.android.com/training/secure-file-sharing/setup-sharing).
Unknown/code-containing types offer Save only. A system viewer remains responsible for handling permitted documents.

Save supports every downloaded file type. Desktop creates a new copy with exclusive creation and verifies it;
an existing destination is never overwritten. Android uses the user's system directory picker and a new SAF
document, then streams bytes in bounded buffers and verifies the destination's size and SHA-256. Failed copies
remove only the newly created document. Source files must be canonical regular files inside CLAN's private sandbox.
iOS uses the existing system sharing interface; native iOS build and behavior remain NOT TESTED.

## Native manual checks

Use disposable profiles and record the exact source commit, OS, signing status and device type.

1. Join an authorized CLAN. Download a text file containing literal HTML markup, a small PNG/JPEG, PDF and an unknown
   binary file. Preview text must display markup literally; binary/PDF must show a fallback. Close with Escape/Back.
2. Open With a permitted document. Cancel, then choose an installed viewer. Unknown binary, HTML, SVG and executable
   files must have no Open With control. Verify no broad storage permission or permanent public file URI is granted.
3. Save each file to a new destination. Compare SHA-256 against the host's resource. Cancel the picker and retry.
   Select an existing desktop filename: it must remain unchanged. Android should create a uniquely named new document.
4. Modify only a disposable downloaded copy outside CLAN. Preview/Open/Save must refuse its changed hash.
5. Repeat from chat attachments and the CLAN file table; verify controls remain reachable with the keyboard visible.
6. Windows: test filenames containing spaces, apostrophes and non-ASCII characters. The native chooser must receive
   the file literally and offer no application-registration or elevated operation.

Desktop automated evidence: six chat/sharing/preview E2Es passed, plus a focused rerun of the strengthened preview
test (literal markup, actual text/unknown-file exports and changed-file refusal). Logs are recorded in the progress doc.
Android emulator runtime checks passed passive native text preview, actual SAF picker/permission grant, streamed
export with independent SHA-256 readback, and native chooser cancellation. Physical Android and native Windows/iOS
remain NOT TESTED. Build success alone does not establish physical-device correctness.
