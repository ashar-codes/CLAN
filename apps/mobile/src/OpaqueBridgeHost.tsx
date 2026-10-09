// Hidden, isolated WebView that runs the official OPAQUE WASM build. Threat boundary:
// * content: one locally bundled HTML string (src/generated/opaqueBridgeHtml.ts) — no remote URLs, CSP default-src 'none';
// * navigation: everything except the initial about:blank load is refused; no new windows, no file access;
// * interface: only the three typed operations of the bridge protocol, via postMessage (never injectJavaScript);
// * state: OPAQUE client state stays inside the WebView behind single-use random handles. JS strings can't be
//   reliably zeroed; the WebView is ephemeral (incognito, no cache) and holds at most 16 in-flight states.
// * lifetime: mounted only while joining (from the first call until IDLE_MS after the last), so the phone doesn't keep a
//   WebView renderer process (~150 MB on the emulator) alive the rest of the time.
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { bridgedOpaqueClient } from '@classroom/client/opaque-bridge';
import type { OpaqueClient } from '@classroom/client';
import { OPAQUE_BRIDGE_HTML } from './generated/opaqueBridgeHtml';

const IDLE_MS = 60_000;
let post: ((m: string) => void) | null = null;
let readyResolve: () => void = () => {};
let ready = new Promise<void>((r) => { readyResolve = r; });
let mount: ((on: boolean) => void) | null = null, idle: ReturnType<typeof setTimeout> | undefined;
const bridge = bridgedOpaqueClient((m) => post?.(m));
/** Mounts the WebView (if needed), keeps it for IDLE_MS after this call, and waits until the WASM is loaded. */
const use = async () => {
  clearTimeout(idle); mount?.(true);
  idle = setTimeout(() => mount?.(false), IDLE_MS);
  await ready;
};

/** OpaqueClient that waits for the WebView to finish loading the WASM before each call. */
export function opaqueBridgeClient(): OpaqueClient {
  return {
    startLogin: async (p) => { await use(); return bridge.client.startLogin(p); },
    finishLogin: async (p) => { await use(); return bridge.client.finishLogin(p); },
  };
}

export function OpaqueBridgeHost() {
  const [on, setOn] = useState(false);
  useEffect(() => { mount = setOn; return () => { mount = null; }; }, []);
  return on ? <BridgeView /> : null;
}

function BridgeView() {
  const ref = useRef<WebView>(null);
  useEffect(() => {
    post = (m) => ref.current?.postMessage(m);
    return () => { post = null; ready = new Promise<void>((r) => { readyResolve = r; }); }; // the next mount loads afresh
  }, []);
  return (
    <View style={{ width: 0, height: 0, opacity: 0, position: 'absolute' }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        ref={ref}
        source={{ html: OPAQUE_BRIDGE_HTML }}
        originWhitelist={['about:blank']}
        onShouldStartLoadWithRequest={(r) => r.url === 'about:blank'}
        onMessage={(e) => {
          const d = e.nativeEvent.data;
          if (d === JSON.stringify({ id: 0, ok: true, result: 'ready' })) readyResolve();
          else bridge.receive(d);
        }}
        javaScriptEnabled
        incognito
        cacheEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        mixedContentMode="never"
        domStorageEnabled={false}
        geolocationEnabled={false}
        mediaPlaybackRequiresUserAction
      />
    </View>
  );
}
