import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MOTION, motionStep } from '../../../packages/design/src/motion.ts';
it('preserves the established motion tokens across native and web', () => {
 const css = readFileSync(new URL('../../../packages/design/src/tokens.css', import.meta.url), 'utf8');
 for (const k of ['quick','base','slow'] as const) expect(css).toContain(`--t-${k}: ${MOTION[k]}ms`);
});
it('reduced motion snaps to the destination; delayed frames cannot overshoot', () => {
 expect(motionStep(.016, false)).toBe(1);
 expect(motionStep(-1, true)).toBe(0);
 expect(motionStep(8, true)).toBe(motionStep(.05, true));
 expect(motionStep(.016, true)).toBeGreaterThan(0);
 expect(motionStep(.016, true)).toBeLessThan(1);
});
