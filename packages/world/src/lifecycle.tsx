import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
/** A lost GPU context releases the scene and lets its DOM controls take over. */
export function SceneLifecycle({ onLost }: { onLost(): void }) {
  const { gl } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => { event.preventDefault(); onLost(); };
    canvas.addEventListener('webglcontextlost', lost);
    canvas.dataset.clanSceneReady = 'true';
    return () => { delete canvas.dataset.clanSceneReady; canvas.removeEventListener('webglcontextlost', lost); };
  }, [gl, onLost]);
  return null;
}
