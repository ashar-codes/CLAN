// Only real discovery entries; placement is decorative, never a location or distance.
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useC } from './kit';
export function Radar({ items, onSelect }: { items: { id: string; name: string; kind: string; verified?: boolean }[]; onSelect(id: string): void }) {
  const c = useC(), turn = useRef(new Animated.Value(0)).current;
  const [reduce, setReduce] = useState(true), [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => { void AccessibilityInfo.isReduceMotionEnabled().then(setReduce); const r = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce), a = AppState.addEventListener('change', (x) => setActive(x === 'active')); return () => { r.remove(); a.remove(); }; }, []);
  useEffect(() => { if (reduce || !active) return; const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 9000, easing: Easing.linear, useNativeDriver: true })); loop.start(); return () => loop.stop(); }, [reduce, active, turn]);
  return <View style={{ width: 280, height: 280, alignSelf: 'center', borderRadius: 28, backgroundColor: c.bg2, overflow: 'hidden' }} accessibilityLabel="Discovery radar">
    <Svg width={280} height={280} style={{ position: 'absolute' }}>{[40, 80, 120].map((r) => <Circle key={r} cx={140} cy={140} r={r} fill="none" stroke={c.border} />)}</Svg>
    <Animated.View pointerEvents="none" style={{ position: 'absolute', transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }}><Svg width={280} height={280}><Path d="M140 140 L140 20 A120 120 0 0 1 244 80 Z" fill={c.ok} opacity={0.15} /></Svg></Animated.View>
    {items.slice(0, 12).map((x, i) => { const a = i * 2.399, r = 50 + i % 3 * 24; return <Pressable key={x.id} accessibilityRole="button" accessibilityLabel={`${x.name}, ${x.kind}`} onPress={() => onSelect(x.id)} style={{ position: 'absolute', left: 140 + Math.cos(a) * r - 40, top: 140 + Math.sin(a) * r - 22, width: 80, minHeight: 44, alignItems: 'center', backgroundColor: c.surface, borderColor: x.verified ? c.ok : c.border, borderWidth: 1, borderRadius: 12, padding: 4 }}><Text style={{ color: c.text }}>{x.verified ? '✓' : x.kind === 'Person' ? '●' : '▦'}</Text><Text numberOfLines={1} style={{ color: c.text, fontSize: 10 }}>{x.name}</Text></Pressable>; })}
    <Text style={{ position: 'absolute', bottom: 6, left: 12, color: c.text2, fontSize: 12 }}>{items.length} discovered · no distances</Text>
  </View>;
}
