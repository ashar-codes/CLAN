import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Group } from 'three';
import type { BeaconState, CLANmateSpec } from '@clan/design';

/** CSS token → colour three.js understands (tokens stay the single source of colour). */
export const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

export function Mate3D({ spec, beacon, selected, phase = 0 }: { spec: CLANmateSpec; beacon: BeaconState; selected?: boolean; phase?: number }) {
  const body = useRef<Group>(null), ring = useRef<Group>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + phase;
    if (body.current) body.current.position.y = Math.sin(t * 1.6) * 0.02;
    if (ring.current) ring.current.rotation.z = beacon === 'transfer' ? -t * 3 : Math.sin(t) * 0.15;
  });
  const bare = spec.bottom === 'skirt' || spec.bottom === 'shorts';
  return (
    <group>
      {selected && <mesh rotation-x={-Math.PI / 2} position-y={0.01}><ringGeometry args={[0.38, 0.46, 40]} /><meshBasicMaterial color={token('--clay')} /></mesh>}
      <group ref={body}>
        {[-0.09, 0.09].map((x) => <mesh key={x} position={[x, 0.27, 0]}><boxGeometry args={[0.13, 0.5, 0.14]} /><meshStandardMaterial color={bare ? spec.skin : spec.bottomColor} /></mesh>)}
        {[-0.09, 0.09].map((x) => <mesh key={`s${x}`} position={[x, 0.03, 0.03]}><boxGeometry args={[0.15, 0.07, 0.22]} /><meshStandardMaterial color={spec.shoeColor} /></mesh>)}
        {spec.bottom === 'skirt' && <mesh position-y={0.47}><cylinderGeometry args={[0.17, 0.25, 0.22, 16]} /><meshStandardMaterial color={spec.bottomColor} /></mesh>}
        <mesh position-y={0.75}><capsuleGeometry args={[0.2, 0.3, 6, 14]} /><meshStandardMaterial color={spec.topColor} /></mesh>
        {spec.backpack && <mesh position={[0, 0.78, -0.22]}><boxGeometry args={[0.3, 0.36, 0.14]} /><meshStandardMaterial color={spec.backpack} /></mesh>}
        <mesh position-y={1.17}><sphereGeometry args={[0.2, 20, 16]} /><meshStandardMaterial color={spec.skin} /></mesh>
        <mesh position-y={1.22} scale={spec.hair === 'buzz' ? [1, 0.7, 1] : [1.08, 0.9, 1.08]}><sphereGeometry args={[0.2, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color={spec.hairColor} /></mesh>
        {[-0.07, 0.07].map((x) => <mesh key={`e${x}`} position={[x, 1.17, 0.19]}><sphereGeometry args={[0.022, 8, 6]} /><meshBasicMaterial color="#1d2320" /></mesh>)}
        {spec.hair === 'bun' && <mesh position-y={1.44}><sphereGeometry args={[0.08, 12, 10]} /><meshStandardMaterial color={spec.hairColor} /></mesh>}
        <group ref={ring} position={[0.38, 1.05, 0]}>
          <mesh><torusGeometry args={[0.1, 0.028, 8, 28, beacon === 'focus' ? Math.PI * 2 : Math.PI * 1.55]} /><meshStandardMaterial color={token(`--beacon-${beacon}`)} emissive={token(`--beacon-${beacon}`)} emissiveIntensity={0.35} /></mesh>
        </group>
      </group>
    </group>
  );
}
