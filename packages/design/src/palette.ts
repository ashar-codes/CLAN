// The CLAN palette as plain values, for surfaces that can't read CSS variables (React Native, three.js).
// Must equal tokens.css (checked by apps/desktop/test/palette.test.ts).
export const light = {
  paper: '#f7f1e6', paper2: '#eee4d1', surface: '#fffbf3', ink: '#17233b', ink2: '#3a4560', ink3: '#636b80', line: '#e0d4bf',
  campus: '#287a4e', notebook: '#f0b02f', brick: '#c04826', burgundy: '#8a2d48', study: '#2a66c1', ai: '#6a4fd6', transfer: '#138a87',
  wood: '#c99566', wall: '#f1e7d6', floor: '#e7dbc4',
} as const;
export const dark: { [K in keyof typeof light]: string } = {
  paper: '#0e1424', paper2: '#151d31', surface: '#1a243d', ink: '#f3ead9', ink2: '#cbc2b0', ink3: '#959bab', line: '#2a3552',
  campus: '#52b882', notebook: '#f5c45c', brick: '#ee7049', burgundy: '#cf6283', study: '#6aa0ee', ai: '#9b8cf2', transfer: '#3bbcb6',
  wood: '#7a5434', wall: '#18213a', floor: '#121a2e',
};
