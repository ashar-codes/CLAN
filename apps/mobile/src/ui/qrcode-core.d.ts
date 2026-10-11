// The dependency-free core of `qrcode` (matrix only). Imported directly so its Node-oriented typings (which would
// replace the phone's node:crypto/node:fs shims with Node's ambient declarations) never enter the phone build.
declare module 'qrcode/lib/core/qrcode' {
  export function create(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): { modules: { size: number; data: Uint8Array } };
}
