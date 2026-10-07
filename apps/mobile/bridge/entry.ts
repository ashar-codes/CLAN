// Runs INSIDE the isolated WebView. The official @serenity-kit/opaque 1.1.0 build (WASM embedded) + the narrow bridge.
import * as opaque from '@serenity-kit/opaque';
import { createBridgeHandler } from '@classroom/client/opaque-bridge';

type W = Window & { ReactNativeWebView?: { postMessage(s: string): void }; __bridgeOutbox?: string[] };
const w = window as W;
// React Native WebView channel; the outbox exists only so the same page can be exercised in a desktop browser engine (tests).
const out = (s: string) => (w.ReactNativeWebView ? w.ReactNativeWebView.postMessage(s) : (w.__bridgeOutbox ??= []).push(s));
const handle = () => {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
};

opaque.ready.then(() => {
  const dispatch = createBridgeHandler(opaque.client, handle);
  const onMessage = (e: Event) => { const r = dispatch((e as MessageEvent).data); if (r) out(r); };
  window.addEventListener('message', onMessage); // iOS
  document.addEventListener('message', onMessage); // Android
  out(JSON.stringify({ id: 0, ok: true, result: 'ready' }));
});
