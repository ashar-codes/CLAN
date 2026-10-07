// One palette: the plain-value copy used by React Native / three.js must match the CSS tokens.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dark, light } from '@clan/design/palette';

const css = readFileSync(join(import.meta.dirname, '../../../packages/design/src/tokens.css'), 'utf8');
const NAMES: Record<string, string> = { paper2: 'paper-2', ink2: 'ink-2', ink3: 'ink-3' };
const block = (sel: string) => css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
const value = (src: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(src)?.[1];

describe('palette', () => {
  it('light and dark (campus at night) values equal tokens.css', () => {
    for (const [k, v] of Object.entries(light)) expect(value(block(':root {'), NAMES[k] ?? k), k).toBe(v);
    for (const [k, v] of Object.entries(dark)) expect(value(block(":root[data-theme='dark']"), NAMES[k] ?? k), k).toBe(v);
  });
});
