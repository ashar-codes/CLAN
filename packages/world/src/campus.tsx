// Knowledge Campus: building = course, floor = lecture (solid = attended), lit windows = studying now,
// kiosks = resources, paths = prerequisites, column = term. Selecting a building glides the camera to it.
import { useRef, useState, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { CourseBuildingViewModel } from './index.ts';
import { token } from './mate3d.tsx';
import { settle, useSceneMotion } from './motion';
import { SceneLifecycle } from './lifecycle';

const FLOOR = 0.5;
const place = (courses: CourseBuildingViewModel[]) => {
  const slot = new Map<number, number>();
  const raw = courses.map((c) => { const n = slot.get(c.term) ?? 0; slot.set(c.term, n + 1); return [c.id, new Vector3((c.term - 1.5) * 3.2, 0, (n - 0.5) * 3)] as const; });
  // centre the campus that exists so a small campus fills the view
  const cx = raw.reduce((a, [, v]) => a + v.x, 0) / Math.max(raw.length, 1), cz = raw.reduce((a, [, v]) => a + v.z, 0) / Math.max(raw.length, 1);
  return new Map(raw.map(([id, v]) => [id, new Vector3(v.x - cx, 0, v.z - cz)]));
};

function Rig({ target, extent }: { target: Vector3 | null; extent: number }) {
  const { camera, size, invalidate } = useThree();
  const motion = useSceneMotion();
  const look = useRef(new Vector3());
  useFrame((_, dt) => {
    const goal = target ?? new Vector3(0, 0, 0);
    const back = size.width < size.height ? 1.7 : 1; // portrait screens need the camera further out
    const d = Math.max(7, extent * 1.8) * back;
    const camGoal = target ? new Vector3(goal.x + 4.6, 5.6, goal.z + 6.8) : new Vector3(0, d * 0.8, d);
    const k = settle(dt, motion);
    camera.position.lerp(camGoal, k); look.current.lerp(goal, k); camera.lookAt(look.current);
    if (motion && (camera.position.distanceTo(camGoal) > .005 || look.current.distanceTo(goal) > .005)) invalidate();
  });
  return null;
}

function Building({ c, at, selected, onSelect }: { c: CourseBuildingViewModel; at: Vector3; selected: boolean; onSelect(): void }) {
  let lit = c.studyingNow;
  const round = [...c.code].reduce((n, char) => n + char.charCodeAt(0), 0) % 2 === 0;
  return (
    <group position={at} onClick={(e) => { e.stopPropagation(); onSelect(); }}>
      {/* A foundation and entrance exist even before a course has topics. Neither represents progress. */}
      <mesh position-y={-.08}><cylinderGeometry args={[1.25, 1.35, .16, 32]} /><meshStandardMaterial color={token('--floor')} roughness={1} /></mesh>
      <mesh position-y={-.18}><cylinderGeometry args={[1.5, 1.6, .14, 32]} /><meshBasicMaterial color={token('--campus-soft')} /></mesh>
      {c.lectures.length === 0 && <mesh position-y={.12}><boxGeometry args={[1.4, .24, 1.4]} /><meshStandardMaterial color={token('--surface')} /></mesh>}
      <mesh position={[0, .14, .74]}><boxGeometry args={[.46, .28, .18]} /><meshStandardMaterial color={c.color} /></mesh>
      <mesh position={[0, .05, 1.02]}><boxGeometry args={[.7, .1, .42]} /><meshStandardMaterial color={token('--line')} /></mesh>
      <mesh position-y={Math.max(.24, c.lectures.length * FLOOR) + .09} rotation-y={Math.PI / 4}><cylinderGeometry args={[round ? .98 : 1.08, round ? 1.02 : 1.13, .18, round ? 32 : 4]} /><meshStandardMaterial color={c.color} roughness={.8} /></mesh>
      {[[-.72, -.72], [.72, -.72], [-.72, .72], [.72, .72]].map(([x, z], i) => <mesh key={`column${i}`} position={[x!, Math.max(.24, c.lectures.length * FLOOR) / 2, z!]}><cylinderGeometry args={[.045, .06, Math.max(.24, c.lectures.length * FLOOR), 8]} /><meshStandardMaterial color={token('--wood')} /></mesh>)}
      {c.lectures.map((l, i) => {
        const windows = Math.min(3, lit); lit -= windows;
        return (
          <group key={l.id} position-y={FLOOR / 2 + i * FLOOR}>
            <mesh><boxGeometry args={[1.4, FLOOR * 0.92, 1.4]} /><meshStandardMaterial color={l.done ? c.color : token('--surface')} roughness={.85} /></mesh>
            <mesh position-y={FLOOR * .44}><boxGeometry args={[1.48, .055, 1.48]} /><meshStandardMaterial color={token('--line')} /></mesh>
            {[-.42, 0, .42].map((x) => <mesh key={`window${x}`} position={[x, 0, .706]}><planeGeometry args={[.25, .28]} /><meshStandardMaterial color={token('--window')} /></mesh>)}
            {Array.from({ length: windows }, (_, w) => <mesh key={w} position={[-0.4 + w * 0.4, 0, 0.705]}><planeGeometry args={[0.3, FLOOR * 0.62]} /><meshBasicMaterial color="#ffc93d" toneMapped={false} /></mesh>)}
          </group>
        );
      })}
      {Array.from({ length: c.resources }, (_, r) => <mesh key={r} position={[1.05, 0.12, -0.55 + r * 0.32]}><boxGeometry args={[0.22, 0.24, 0.22]} /><meshStandardMaterial color={token('--mustard')} /></mesh>)}
      {c.examSoon && <mesh position-y={Math.max(1, c.lectures.length) * FLOOR + 0.45}><coneGeometry args={[0.28, 0.6, 4]} /><meshStandardMaterial color={token('--brick')} /></mesh>}
      {selected && <mesh rotation-x={-Math.PI / 2} position-y={0.01}><ringGeometry args={[1.15, 1.25, 4, 1, Math.PI / 4]} /><meshBasicMaterial color={token('--clay')} /></mesh>}
    </group>
  );
}

export default function CampusScene({ courses, focusId, onSelect, onReady }: { courses: CourseBuildingViewModel[]; focusId?: string; onSelect(id: string | null): void; onReady?(): void }) {
  const [lost, setLost] = useState(false);
  const lose = useCallback(() => setLost(true), []);
  const at = place(courses);
  const paths = courses.flatMap((c) => c.prerequisites.filter((p) => at.has(p)).map((p) => [at.get(p)!, at.get(c.id)!] as const));
  if (lost) return <div role="status" className="card"><p>3D is unavailable. Your courses are ready below.</p>{courses.map((c) => <button key={c.id} onClick={() => onSelect(c.id)}>{c.name}</button>)}</div>;
  return (
    <Canvas frameloop="demand" camera={{ position: [0, 9, 11], fov: 40 }} dpr={[1, 1.5]} onPointerMissed={() => onSelect(null)} aria-label="Knowledge Campus" onCreated={() => onReady?.()}>
      <SceneLifecycle onLost={lose} />
      <color attach="background" args={[token('--paper')]} />
      <hemisphereLight args={['#fff6e8', '#d9c9ad', 1.7]} />
      <directionalLight position={[5, 10, 6]} intensity={1.3} />
      <mesh rotation-x={-Math.PI / 2} position-y={-.27}><planeGeometry args={[30, 30]} /><meshBasicMaterial color={token('--paper')} /></mesh>
      {/* Entrance walks are decorative circulation, separate from academic prerequisite links. */}
      {courses.map((c) => { const p = at.get(c.id)!; return <mesh key={`walk${c.id}`} position={[p.x, -.19, p.z + 1.8]} rotation-x={-Math.PI / 2}><planeGeometry args={[.5, 1.2]} /><meshBasicMaterial color={token('--floor')} /></mesh>; })}
      {paths.map(([a, b], i) => {
        const mid = a.clone().add(b).multiplyScalar(0.5), len = a.distanceTo(b);
        return <mesh key={i} position={[mid.x, 0.01, mid.z]} rotation={[-Math.PI / 2, 0, -Math.atan2(b.z - a.z, b.x - a.x)]}><planeGeometry args={[len, 0.18]} /><meshStandardMaterial color={token('--line')} /></mesh>;
      })}
      {courses.map((c) => <Building key={c.id} c={c} at={at.get(c.id)!} selected={c.id === focusId} onSelect={() => onSelect(c.id)} />)}
      <Rig target={focusId ? at.get(focusId) ?? null : null} extent={Math.max(1, ...courses.map((c) => c.lectures.length * FLOOR), ...[...at.values()].map((v) => Math.hypot(v.x, v.z) + 1.5))} />
    </Canvas>
  );
}
