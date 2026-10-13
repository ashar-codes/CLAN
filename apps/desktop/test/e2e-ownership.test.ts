import { expect, it } from 'vitest';
import { belongsToRun } from '../e2e/global-teardown.ts';

it('cleanup distinguishes simultaneous test runners and retains reparented apps', () => {
  const parents = new Map([[20, 10], [21, 20], [31, 30], [40, 1]]);
  expect(belongsToRun(21, 10, parents)).toBe(true);
  expect(belongsToRun(31, 10, parents)).toBe(false);
  expect(belongsToRun(40, 10, parents)).toBe(false);
  expect(belongsToRun(999, 10, parents)).toBe(false);
});

it('uncertain or cyclic process ancestry never authorizes termination', () => {
  expect(belongsToRun(21, 10, new Map([[21, 22], [22, 21]]))).toBe(false);
  expect(belongsToRun(21, 10, new Map([[21, 0]]))).toBe(false);
});
