// Screen-capture failures explained from the real error and the main-process capture stages (docs/SCREEN_SHARING_ROOT_CAUSE.md).
import type { CaptureDiagnostics } from '../../../shared.ts';

/** Why a capture or publish failed, from the real error and the main-process capture stages (never a guess). */
export type CaptureFailure = { kind: 'permission' | 'restart' | 'source' | 'cancelled' | 'init' | 'refused' | 'publish' | 'server'; text: string; detail: string; diag: CaptureDiagnostics | null };
export function classifyCapture(e: unknown, d: CaptureDiagnostics | null, stage: 'capture' | 'publish' = 'capture'): CaptureFailure {
  const err = (e ?? {}) as { name?: string; message?: string; code?: unknown };
  const name = err.name ?? 'Error', message = String(err.message ?? e).slice(0, 200);
  const mac = d?.platform === 'darwin';
  const detail = `${name}${err.code != null ? ` (${String(err.code)})` : ''}: ${message}`;
  const f = (kind: CaptureFailure['kind'], text: string): CaptureFailure => ({ kind, text, detail, diag: d });
  if (stage === 'publish') return /token|401|403|forbidden|not allowed to publish/i.test(message) ? f('refused', 'The host has not allowed this screen to be published. Ask the host, then try again.')
    : /connect|websocket|signal|timeout|network/i.test(message) ? f('server', 'Couldn’t reach the presentation server in this CLAN. Check the connection to the host and try again.')
    : f('publish', 'The selected screen was captured but could not be published to the room. Try again.');
  if (/no longer available/.test(message) || name === 'NotFoundError' || d?.sourceFound === false) return f('source', 'The selected screen or window is no longer available. Refresh the list and choose again.');
  if (mac && d && d.screen !== 'granted') return f('permission', 'Screen Recording permission is off for CLAN. Turn CLAN on in System Settings › Privacy & Security › Screen & System Audio Recording, then quit and reopen CLAN.');
  if (name === 'AbortError' || name === 'NotReadableError') return f(mac ? 'restart' : 'init', mac
    ? 'macOS could not start capturing this source. If you just turned on Screen Recording, quit and reopen CLAN; otherwise choose another screen or window.'
    : 'The system could not start capturing this source. Choose another screen or window, or restart CLAN.');
  if (name === 'InvalidStateError') return f('cancelled', 'Capture has to start from your click. Press Share again.');
  if (name === 'NotAllowedError' && d?.permissionGranted === false) return f('cancelled', 'The screen choice expired before capture started. Choose the screen again.');
  if (name === 'NotAllowedError') return f(mac ? 'restart' : 'init', mac
    ? 'macOS refused to capture the screen. Check that this CLAN app is on in Screen & System Audio Recording (turn it off and on again after an update), then quit and reopen CLAN.'
    : 'The system refused to capture this source. Choose another screen or window, or restart CLAN.');
  return f('init', 'Screen capture could not start. Try again or choose another screen or window.');
}
