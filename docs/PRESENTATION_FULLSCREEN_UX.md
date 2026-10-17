# Immersive presentation and the floating + menu

## Desktop (`world/Presentation.tsx` ScreenWall, `world/PresentationTools.tsx`)
- **Enter:** the **Fullscreen** button on the wall, or double-click the shared screen. The wall covers the whole window and
  the window goes fullscreen on its current display (multi-monitor: the display CLAN is on).
- **Exit:** Esc, double-click, **Exit fullscreen**, or leaving fullscreen in any other way. When the presentation ends,
  fullscreen closes on its own.
- **View:** Fit to screen (aspect ratio kept, no cropping), Actual size (one video pixel per screen pixel, scrollable,
  best for small text), 200%. Mute/Unmute appears only when the presenter shares sound (Windows). A connection-quality
  indicator is shown.
- **Floating +:** bottom-right, inside safe areas. It fades to 30% after 2.5 s without pointer or keyboard activity and
  returns on movement, hover or focus. It is a real button (`aria-expanded`, `aria-haspopup="menu"`); Esc closes the menu.

| Menu item | What it does (all existing CLAN features) |
|---|---|
| Take Notes | Floating note editor over the playing stream: movable (drag the title), resizable, minimizable. Save writes a **private** note to your Inbox through the existing Quick Capture service (`capture:add` → Notes); later saves update the same note. Optionally adds when and where it was taken. Works offline. |
| Quick Capture | Opens the existing Quick Capture menu (note, task, reminder, link, file, idea) above the presentation |
| Chat | Shows the room's existing chat panel as a side sheet over the presentation (only when the room has chat) |
| Participants | Who is in the room, the host, and who is presenting (only when you may see members) |
| Presentation Controls | Status, quality, zoom, sound, Exit fullscreen, Leave view |

The presenter keeps the presenter bar (Switch source, Stop). The host's "Stop presentation" stays in the room controls
outside fullscreen. Raise Hand, Save Reference and shared files are not in the menu, because they are not wired to the
wall yet. No item is shown that does not work.

**Notes are never lost:** closing the editor with unsaved text asks first. If the presentation ends, or you leave the
view while typing, the text is saved to your Inbox automatically.

## Android (`apps/mobile/src/media/Watch.tsx`)
Watch, then Fullscreen: an immersive landscape or portrait view with the status bar hidden, the video always fitted and
never cropped, and an Exit button. A floating **+** offers Take Notes (a sheet over the video that avoids the keyboard,
can be minimized and is saved privately to the phone's Inbox), quality, Exit fullscreen and Leave presentation view.
Closing with unsaved text asks Save / Discard / Keep editing; ending the view saves automatically. Android cannot
broadcast its own screen in this phase.

## Privacy
- The menu, editor and panels are ordinary local UI. They are never published as media tracks, and notes are never put
  into the chat.
- **Limitation:** if *you* share an entire physical screen, macOS and Windows capture everything on it, including a CLAN
  note window placed on that screen. CLAN cannot exclude it and does not try OS-level concealment tricks. The picker says
  so; share a single window to keep notes off-screen for others.
- Diagnostics never include window titles, thumbnails or frames.
