// Decorative social seating. Positions and rings never represent physical distance.
import { useEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import type { NearbyPersonViewModel } from './index.ts';
import { Mate3D, token } from './mate3d.tsx';
import { useSceneMotion } from './motion';

const RADIUS = { here: 1.6, near: 3, far: 4.4 };

function Tree({ p }: { p: [number, number, number] }) {
  return <group position={p}><mesh position-y={0.35}><cylinderGeometry args={[0.06, 0.08, 0.7, 8]} /><meshStandardMaterial color="#7a5a3c" /></mesh><mesh position-y={1}><icosahedronGeometry args={[0.45, 0]} /><meshStandardMaterial color={token('--sage')} flatShading /></mesh></group>;
}

/** Portrait screens: pull the camera back so the whole courtyard fits. */
function Fit() {
  const { camera, size } = useThree();
  useEffect(() => { const k = size.width < size.height ? 1.75 : 1; camera.position.set(0, 6.5 * k, 8 * k); camera.lookAt(0, 0, 0); }, [camera, size.width, size.height]);
  return null;
}

export default function CommonsScene({ people, selectedId, onSelect, onReady }: { people: NearbyPersonViewModel[]; selectedId?: string; onSelect(id: string): void; onReady?(): void }) {
  const [hover, setHover] = useState(false);
  const motion = useSceneMotion();
  const by = { here: [] as NearbyPersonViewModel[], near: [] as NearbyPersonViewModel[], far: [] as NearbyPersonViewModel[] };
  for (const p of people) by[p.distance].push(p);
  return (
    <Canvas frameloop={motion && people.length > 0 ? 'always' : 'demand'} camera={{ position: [0, 6.5, 8], fov: 38 }} dpr={[1, 1.5]} style={{ cursor: hover ? 'pointer' : 'default' }} aria-label="Commons — decorative seating, not physical locations" onCreated={() => onReady?.()}>
      <color attach="background" args={[token('--paper')]} />
      <hemisphereLight args={['#fff6e8', '#b9a990', 1.4]} />
      <directionalLight position={[4, 8, 5]} intensity={1.2} />
      <mesh rotation-x={-Math.PI / 2}><circleGeometry args={[6, 64]} /><meshStandardMaterial color={token('--paper-2')} /></mesh>
      {[RADIUS.here, RADIUS.near, RADIUS.far].map((r) => <mesh key={r} rotation-x={-Math.PI / 2} position-y={0.005}><ringGeometry args={[r - 0.02, r + 0.02, 96]} /><meshBasicMaterial color={token('--line')} /></mesh>)}
      <mesh position-y={0.05}><cylinderGeometry args={[0.5, 0.6, 0.1, 32]} /><meshStandardMaterial color={token('--line')} /></mesh>
      {([[-4.6, 0, -2.4], [4.8, 0, -1.6], [-3.6, 0, 3.4], [5, 0, 2.8], [0.4, 0, -5.2]] as const).map((p, i) => <Tree key={i} p={[...p]} />)}
      <Fit />
      {(Object.keys(by) as (keyof typeof by)[]).flatMap((d) => by[d].map((p, i) => {
        const a = (i / Math.max(by[d].length, 1)) * Math.PI * 2 + (d === 'near' ? 0.4 : d === 'far' ? 0.9 : 0);
        return (
          <group key={p.id} position={[Math.sin(a) * RADIUS[d], 0, Math.cos(a) * RADIUS[d]]} rotation-y={Math.sin(a) * 0.5}
            onClick={(e) => { e.stopPropagation(); onSelect(p.id); }} onPointerOver={() => setHover(true)} onPointerOut={() => setHover(false)}>
            <Mate3D spec={p.spec} beacon={p.beacon} selected={p.id === selectedId} phase={i * 0.7} />
          </group>
        );
      }))}
    </Canvas>
  );
}
