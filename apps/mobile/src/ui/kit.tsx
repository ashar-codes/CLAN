// CLAN's phone kit: the shared palette, room-like headers and a compact CLANmate — no 3D, no animation. Touch targets
// are ≥ 48 dp, every control has an accessibility label, and data reads come straight from @clan/core.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, useColorScheme, View, type TextInputProps } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { dark, light } from '@clan/design/palette';
import { mateFor } from '@clan/design/avatar';

const theme = (p: typeof light | typeof dark) => ({ bg: p.paper, bg2: p.paper2, surface: p.surface, text: p.ink, text2: p.ink2, muted: p.ink3, border: p.line, accent: p.ink, danger: p.brick,
  ok: p.campus, warn: p.notebook, wall: p.wall, floor: p.floor, wood: p.wood, study: p.study, ai: p.ai, transfer: p.transfer, burgundy: p.burgundy });
export type C = ReturnType<typeof theme>;
const Theme = createContext<C>(theme(light));
export const useC = () => useContext(Theme);
export function ThemeRoot({ children }: { children: ReactNode }) { return <Theme.Provider value={theme(useColorScheme() === 'dark' ? dark : light)}>{children}</Theme.Provider>; }

// ---- re-render after core changes (local edits, sync) ----
const subs = new Set<() => void>();
/** Call after anything changes core data; every mounted `useData` re-reads. */
export const bump = () => { for (const f of subs) f(); };
/** Reads core synchronously on every render and re-renders on `bump()`. A read that throws yields undefined. */
export function useData<T>(read: () => T): T | undefined {
  const [, set] = useState(0);
  useEffect(() => { const f = () => set((x) => x + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  try { return read(); } catch { return undefined; }
}
/** Run a core mutation; returns an error message or null, and refreshes the screens. */
export function act(f: () => unknown): string | null { try { const r = f(); if (r instanceof Promise) void r.then(bump, () => bump()); bump(); return null; } catch (e) { return (e as Error).message; } }

// ---- layout ----
export function Screen({ children }: { children: ReactNode }) {
  const c = useC();
  return <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 96 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}
export const H1 = ({ children }: { children: ReactNode }) => { const c = useC(); return <Text accessibilityRole="header" style={{ color: c.text, fontSize: 26, fontWeight: '800' }}>{children}</Text>; };
export const H2 = ({ children }: { children: ReactNode }) => { const c = useC(); return <Text accessibilityRole="header" style={{ color: c.text, fontSize: 17, fontWeight: '700' }}>{children}</Text>; };
export const Muted = ({ children, small }: { children: ReactNode; small?: boolean }) => { const c = useC(); return <Text style={{ color: c.muted, fontSize: small ? 12 : 14 }}>{children}</Text>; };
export const Err = ({ msg }: { msg: string | null | undefined }) => { const c = useC(); return msg ? <Text accessibilityLiveRegion="polite" style={{ color: c.danger }}>{msg}</Text> : null; };
export function Card({ title, children, tone }: { title?: string; children: ReactNode; tone?: keyof C }) {
  const c = useC();
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 18, padding: 14, gap: 10, backgroundColor: c.surface, borderLeftWidth: tone ? 5 : 1, borderLeftColor: tone ? c[tone] : c.border }}>
      {title && <H2>{title}</H2>}{children}
    </View>
  );
}
export const Row = ({ children, gap = 8 }: { children: ReactNode; gap?: number }) => <View style={{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: 'wrap' }}>{children}</View>;
export function Btn({ label, onPress, primary, danger, disabled, small, on, a11y }: { label: string; onPress(): void; primary?: boolean; danger?: boolean; disabled?: boolean; small?: boolean; on?: boolean; a11y?: string }) {
  const c = useC(), fill = primary || on;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y ?? label} accessibilityState={{ disabled, selected: on }} disabled={disabled} onPress={onPress} hitSlop={6}
      style={({ pressed }) => ({ minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: small ? 12 : 18, borderRadius: 14, borderWidth: 1,
        backgroundColor: fill ? (danger ? c.danger : c.accent) : c.surface, borderColor: danger ? c.danger : fill ? c.accent : c.border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 })}>
      <Text style={{ color: fill ? c.bg : danger ? c.danger : c.text, fontSize: small ? 15 : 16, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}
export function Field({ label, value, onChange, multiline, ...rest }: { label: string; value: string; onChange(v: string): void; multiline?: boolean } & Omit<TextInputProps, 'value' | 'onChange'>) {
  const c = useC();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: c.text2, fontWeight: '600' }}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} multiline={multiline} placeholderTextColor={c.muted}
        style={{ borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 12, minHeight: multiline ? 120 : 48, fontSize: 16, color: c.text, backgroundColor: c.bg, textAlignVertical: multiline ? 'top' : 'center' }} {...rest} />
    </View>
  );
}
export function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange(v: T): void }) {
  return (
    <View style={{ gap: 4 }} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Muted>{label}</Muted>
      <Row gap={6}>{options.map(([v, l]) => <Btn key={v} small label={l} on={v === value} onPress={() => onChange(v)} />)}</Row>
    </View>
  );
}

export const when = (t: number | null | undefined) => (t == null ? '' : new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
/** Native date (+ time) selection: Android's dialogs, iOS's inline picker. Never a typed date. */
export function DateField({ label, value, onChange, time = true }: { label: string; value: number | null; onChange(v: number | null): void; time?: boolean }) {
  const c = useC();
  const [ios, setIos] = useState(false);
  const base = value ?? (() => { const d = new Date(); d.setHours(9, 0, 0, 0); d.setDate(d.getDate() + 1); return d.getTime(); })();
  const pick = () => {
    if (Platform.OS !== 'android') return setIos(!ios);
    DateTimePickerAndroid.open({ value: new Date(base), mode: 'date', onChange: (e, d) => {
      if (e.type !== 'set' || !d) return;
      if (!time) return onChange(d.getTime());
      DateTimePickerAndroid.open({ value: d, mode: 'time', onChange: (e2, t) => { if (e2.type === 'set' && t) onChange(t.getTime()); } });
    } });
  };
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: c.text2, fontWeight: '600' }}>{label}</Text>
      <Row>
        <Btn small label={value ? when(value) : 'Choose…'} a11y={`${label}: ${value ? when(value) : 'not set'}`} onPress={pick} />
        {value !== null && <Btn small label="Clear" a11y={`Clear ${label}`} onPress={() => onChange(null)} />}
      </Row>
      {ios && <DateTimePicker value={new Date(base)} mode={time ? 'datetime' : 'date'} display="inline" onChange={(_e, d) => d && onChange(d.getTime())} />}
    </View>
  );
}

/** Compact CLANmate: the person's default look (from their name) as a small badge — head, hair, top. */
export function Mate({ name, size = 44 }: { name: string; size?: number }) {
  const m = mateFor(name), u = size / 44;
  return (
    <View accessible accessibilityLabel={`${name}'s CLANmate`} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: m.topColor, overflow: 'hidden', alignItems: 'center' }}>
      <View style={{ position: 'absolute', top: 6 * u, width: 22 * u, height: 12 * u, borderTopLeftRadius: 11 * u, borderTopRightRadius: 11 * u, backgroundColor: m.hairColor }} />
      <View style={{ marginTop: 9 * u, width: 18 * u, height: 18 * u, borderRadius: 9 * u, backgroundColor: m.skin }} />
      <View style={{ marginTop: 2 * u, width: 30 * u, height: 16 * u, borderTopLeftRadius: 12 * u, borderTopRightRadius: 12 * u, backgroundColor: m.topColor, borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)' }} />
    </View>
  );
}
/** A room header: wall with the place's name, a wooden table strip — CLAN's rooms, flattened for phones. */
export function RoomBand({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  const c = useC();
  return (
    <View accessibilityRole="header" accessibilityLabel={`${title}${sub ? `, ${sub}` : ''}`} style={{ borderRadius: 20, overflow: 'hidden', backgroundColor: c.wall }}>
      <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1 }}><Text style={{ color: c.text, fontSize: 24, fontWeight: '800' }}>{title}</Text>{sub ? <Text style={{ color: c.text2 }}>{sub}</Text> : null}</View>
        {right}
      </View>
      <View style={{ height: 10, backgroundColor: c.wood }} />
    </View>
  );
}
