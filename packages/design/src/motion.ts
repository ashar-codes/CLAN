/** Native/3D counterparts of the preserved CSS motion tokens. Milliseconds except damping. */
export const MOTION = Object.freeze({ quick: 140, base: 240, slow: 520, presence: 1600, transfer: 850, damping: 9 });
export const motionStep = (seconds: number, enabled: boolean) => enabled ? 1 - Math.exp(-Math.max(0, Math.min(seconds, .05)) * MOTION.damping) : 1;
