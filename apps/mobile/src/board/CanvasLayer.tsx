import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WbObject, WbObjectData } from '@classroom/protocol';
import { BOARD_CANVAS_HTML } from '../generated/boardCanvasHtml';

/** Two canvas layers reuse the installed WebView engine; native touch/operations stay in MobileBoard. */
export function CanvasLayer({ objects, vp, selected, erased, draft, moving }: {
  objects: WbObject[]; vp: { x: number; y: number; z: number }; selected: string | null;
  erased: string[]; draft: WbObjectData | null; moving: WbObject | null;
}) {
  const ref = useRef<WebView>(null), sent = useRef<WbObject[] | null>(null);
  const previous = useRef(new Map<string, WbObject>());
  const [ready, setReady] = useState(false), [failed, setFailed] = useState(false), [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let delta: { objects?: WbObject[]; upsert?: WbObject[]; remove?: string[] } = {};
    if (sent.current !== objects) {
      const next = new Map(objects.map((o) => [o.id, o]));
      delta = sent.current === null ? { objects } : {
        upsert: objects.filter((o) => previous.current.get(o.id) !== o),
        remove: [...previous.current.keys()].filter((id) => !next.has(id)),
      };
      previous.current = next;
    }
    const frame = { ...delta, vp, selected, erased, draft, moving };
    ref.current?.postMessage(JSON.stringify(frame)); sent.current = objects;
  }, [objects, vp, selected, erased, draft, moving, ready]);
  if (failed) return <View style={{ padding: 16 }}><Text>Board drawing paused.</Text><Pressable accessibilityRole="button" accessibilityLabel="Reload board canvas" onPress={() => { sent.current = null; setReady(false); setFailed(false); setGeneration((n) => n + 1); }} style={{ minHeight: 48 }}><Text>Reload board canvas</Text></Pressable></View>;
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', inset: 0 }}>
    <WebView key={generation} ref={ref} source={{ html: BOARD_CANVAS_HTML }} style={{ backgroundColor: 'transparent' }}
      originWhitelist={['about:blank']} onShouldStartLoadWithRequest={(r) => r.url === 'about:blank'}
      onMessage={(e) => { if (e.nativeEvent.data === 'ready') { sent.current = null; setReady(true); } }}
      onError={() => setFailed(true)} onRenderProcessGone={() => setFailed(true)} onContentProcessDidTerminate={() => setFailed(true)}
      javaScriptEnabled incognito cacheEnabled={false} scrollEnabled={false} allowFileAccess={false}
      allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false} mixedContentMode="never" domStorageEnabled={false} geolocationEnabled={false} />
  </View>;
}
