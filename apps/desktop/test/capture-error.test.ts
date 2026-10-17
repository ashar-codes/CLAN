// The capture failure shown to the person follows the real error and the capture stages, never a blanket "not allowed".
import { describe, expect, it } from 'vitest';
import { classifyCapture } from '../src/renderer/world/media/captureError.ts';
import type { CaptureDiagnostics } from '../src/shared.ts';

const d = (o: Partial<CaptureDiagnostics> = {}): CaptureDiagnostics => ({ platform: 'darwin', osVersion: '26.5', packaged: true, electron: '44.5.1', screen: 'granted', at: 1, picked: true,
  permissionAsked: true, permissionGranted: true, handlerRan: true, sourceFound: true, sourceKind: 'screen', ...o });
const err = (name: string, message = '') => Object.assign(new Error(message), { name });

describe('classifyCapture', () => {
  it('OS permission off → permission guidance with restart', () => expect(classifyCapture(err('NotAllowedError', 'Permission denied'), d({ screen: 'denied' })).kind).toBe('permission'));
  it('permission granted but macOS still refuses (stale grant after an update) → restart/re-toggle guidance, not "cancelled"', () => {
    const f = classifyCapture(err('NotAllowedError', 'Permission denied'), d());
    expect(f.kind).toBe('restart'); expect(f.text).toMatch(/turn it off and on again/); expect(f.detail).toBe('NotAllowedError: Permission denied');
  });
  it('selected source vanished → source', () => {
    expect(classifyCapture(err('NotAllowedError'), d({ sourceFound: false })).kind).toBe('source');
    expect(classifyCapture(new Error('That source is no longer available.'), d({ handlerRan: false })).kind).toBe('source');
  });
  it('no pending pick when capture started → cancelled/expired, never permission', () => expect(classifyCapture(err('NotAllowedError'), d({ permissionGranted: false })).kind).toBe('cancelled'));
  it('capture could not start → init (Windows) / restart (macOS)', () => {
    expect(classifyCapture(err('NotReadableError', 'Could not start video source'), d({ platform: 'win32' })).kind).toBe('init');
    expect(classifyCapture(err('AbortError'), d()).kind).toBe('restart');
  });
  it('publish failures are named by stage', () => {
    expect(classifyCapture(new Error('could not establish signal connection'), d(), 'publish').kind).toBe('server');
    expect(classifyCapture(new Error('403 forbidden'), d(), 'publish').kind).toBe('refused');
    expect(classifyCapture(new Error('pc failed'), d(), 'publish').kind).toBe('publish');
  });
});
