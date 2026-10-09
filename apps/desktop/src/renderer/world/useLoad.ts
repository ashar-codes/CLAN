import { useCallback, useEffect, useState } from 'react';
const errText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
export function useLoad<T>(f: () => Promise<T>) {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const reload = useCallback(() => { f().then(setV, (e) => setErr(errText(e))); }, [f]);
  useEffect(reload, [reload]);
  // data synced from your other devices appears without navigating away and back
  useEffect(() => (window as unknown as { classroom?: { sync?: { onData?(cb: () => void): () => void } } }).classroom?.sync?.onData?.(reload), [reload]);
  return [v, reload, err] as const;
}
export { errText };
