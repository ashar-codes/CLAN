// Presentation only. No operations, network, domain writes or continuous render loop.
import { bounds, intersects, type WbObjectData } from '@classroom/protocol';
import { draw } from './draw';
type ObjectView = WbObjectData & { id: string; v?: { clock: number } };
type Frame = { objects?: ObjectView[]; upsert?: ObjectView[]; remove?: string[]; vp: { x: number; y: number; z: number }; selected: string | null; erased: string[]; draft: WbObjectData | null; moving: ObjectView | null };
const committed = document.querySelector<HTMLCanvasElement>('#committed')!;
const preview = document.querySelector<HTMLCanvasElement>('#preview')!;
let objects: ObjectView[] = [], boxes: ReturnType<typeof bounds>[] = [];
let frame: Frame = { vp: { x: 0, y: 0, z: .6 }, selected: null, erased: [], draft: null, moving: null };
let scheduled = 0, dirty = true;
const bridge = (window as unknown as { ReactNativeWebView?: { postMessage(s: string): void } }).ReactNativeWebView;
function render() {
  scheduled = 0;
  const start = performance.now(), dpr = Math.min(devicePixelRatio || 1, 2), w = innerWidth, h = innerHeight;
  const setup = (c: HTMLCanvasElement) => {
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); dirty = true; }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    g.scale(frame.vp.z, frame.vp.z); g.translate(-frame.vp.x, -frame.vp.y);
    return g;
  };
  const p = setup(preview);
  let drawn = 0;
  if (dirty) {
    const g = setup(committed), vr = { x: frame.vp.x, y: frame.vp.y, w: w / frame.vp.z, h: h / frame.vp.z }, erased = new Set(frame.erased);
    objects.forEach((o, i) => { if (!erased.has(o.id) && o.id !== frame.moving?.id && intersects(boxes[i]!, vr)) { draw(g, o, o.id === frame.selected); drawn++; } });
    dirty = false;
  }
  if (frame.moving) draw(p, frame.moving, true);
  if (frame.draft) draw(p, frame.draft, false);
  (window as unknown as { __clanBoardPerf: object }).__clanBoardPerf = { renderMs: performance.now() - start, drawn, objects: objects.length };
}
function schedule() { if (!scheduled) scheduled = requestAnimationFrame(render); }
function receive(e: MessageEvent) {
  const next = JSON.parse(e.data) as Frame;
  dirty ||= !!next.objects || !!next.upsert?.length || !!next.remove?.length || JSON.stringify([next.vp, next.selected, next.erased, next.moving?.id]) !== JSON.stringify([frame.vp, frame.selected, frame.erased, frame.moving?.id]);
  if (next.objects) { objects = next.objects; boxes = objects.map(bounds); }
  else if (next.upsert?.length || next.remove?.length) {
    const map = new Map(objects.map((o, i) => [o.id, { o, b: boxes[i]! }]));
    for (const id of next.remove ?? []) map.delete(id);
    for (const o of next.upsert ?? []) map.set(o.id, { o, b: bounds(o) });
    const sorted = [...map.values()].sort((a, b) => a.o.z - b.o.z || (a.o.v?.clock ?? 0) - (b.o.v?.clock ?? 0));
    objects = sorted.map((v) => v.o); boxes = sorted.map((v) => v.b);
  }
  frame = next; schedule();
}
// Android dispatches on document; iOS on window. Messages never become executable source.
document.addEventListener('message', receive as EventListener);
window.addEventListener('message', receive);
window.addEventListener('resize', () => { dirty = true; schedule(); });
window.addEventListener('pagehide', () => { cancelAnimationFrame(scheduled); scheduled = 0; objects = []; boxes = []; });
bridge?.postMessage('ready');
schedule();
