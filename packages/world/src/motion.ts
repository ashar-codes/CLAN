import { useEffect, useState } from 'react';
export { motionStep as settle } from '@clan/design/motion';
/** OS and tab visibility are live inputs, including when Full was selected explicitly. */
export function useSceneMotion() {
  const read = () => !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.experience !== 'minimal';
  const [enabled, set] = useState(read);
  useEffect(() => {
    const change = () => set(read()), media = matchMedia('(prefers-reduced-motion: reduce)');
    const observer = new MutationObserver(change);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-experience'] });
    media.addEventListener('change', change); document.addEventListener('visibilitychange', change);
    return () => { observer.disconnect(); media.removeEventListener('change', change); document.removeEventListener('visibilitychange', change); };
  }, []);
  return enabled;
}
