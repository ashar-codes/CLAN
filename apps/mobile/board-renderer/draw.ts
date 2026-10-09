// Adapted from the production desktop BoardView renderer; same protocol objects.
import { bounds, type WbObjectData } from "@classroom/protocol";
export function draw(g: CanvasRenderingContext2D, o: WbObjectData, selected: boolean) {
  g.save();
  g.strokeStyle = o.color; g.fillStyle = o.color; g.lineWidth = o.width; g.lineCap = 'round'; g.lineJoin = 'round';
  if (o.highlighter) g.globalAlpha = 0.32;
  switch (o.kind) {
    case 'stroke': { const p = o.points ?? []; g.beginPath(); p.forEach(([x, y], i) => (i ? g.lineTo(o.x + x, o.y + y) : g.moveTo(o.x + x, o.y + y))); if (p.length === 1) g.lineTo(o.x + p[0]![0] + 0.1, o.y + p[0]![1]); g.stroke(); break; }
    case 'line': case 'arrow': {
      g.beginPath(); g.moveTo(o.x, o.y); g.lineTo(o.x + o.w, o.y + o.h); g.stroke();
      if (o.kind === 'arrow') { const a = Math.atan2(o.h, o.w), L = 10 + o.width * 2; g.beginPath(); g.moveTo(o.x + o.w, o.y + o.h); g.lineTo(o.x + o.w - L * Math.cos(a - 0.45), o.y + o.h - L * Math.sin(a - 0.45)); g.moveTo(o.x + o.w, o.y + o.h); g.lineTo(o.x + o.w - L * Math.cos(a + 0.45), o.y + o.h - L * Math.sin(a + 0.45)); g.stroke(); }
      break;
    }
    case 'rect': g.strokeRect(o.x, o.y, o.w, o.h); break;
    case 'ellipse': g.beginPath(); g.ellipse(o.x + o.w / 2, o.y + o.h / 2, Math.abs(o.w / 2), Math.abs(o.h / 2), 0, 0, 7); g.stroke(); break;
    case 'text': g.font = `${o.width}px sans-serif`; g.textBaseline = 'top'; (o.text ?? '').split('\n').forEach((l, i) => g.fillText(l, o.x, o.y + i * o.width * 1.25)); break;
    case 'sticky': g.fillStyle = o.fill ?? '#fde68a'; g.shadowColor = 'rgba(0,0,0,.18)'; g.shadowBlur = 6; g.fillRect(o.x, o.y, o.w, o.h); g.shadowBlur = 0; g.fillStyle = o.color; g.font = '15px sans-serif'; g.textBaseline = 'top'; wrap(g, o.text ?? '', o.x + 10, o.y + 10, o.w - 20, 19); break;
    case 'resource': case 'note': case 'link': {
      g.fillStyle = '#ffffff'; g.strokeStyle = '#c9c2b4'; g.lineWidth = 1.5; g.fillRect(o.x, o.y, o.w, o.h); g.strokeRect(o.x, o.y, o.w, o.h);
      g.fillStyle = '#17233b'; g.font = '22px sans-serif'; g.textBaseline = 'top'; g.fillText(o.kind === 'resource' ? (/image/.test(o.ref?.mime ?? '') ? '🖼' : /pdf/.test(o.ref?.mime ?? '') ? '📄' : '▤') : o.kind === 'note' ? '✎' : '↗', o.x + 10, o.y + 10);
      g.font = 'bold 14px sans-serif'; wrap(g, o.ref?.title ?? '', o.x + 44, o.y + 12, o.w - 54, 18); g.font = '11px sans-serif'; g.fillStyle = '#6b6457';
      g.fillText(o.kind === 'resource' ? 'File on the CLAN table' : o.kind === 'note' ? 'Note' : (o.ref?.url ?? '').slice(0, 34), o.x + 44, o.y + o.h - 20); break;
    }
  }
  if (selected) { const b = bounds(o); g.globalAlpha = 1; g.setLineDash([5, 4]); g.strokeStyle = '#1f6feb'; g.lineWidth = 1; g.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8); }
  g.restore();
}
function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, lh: number) {
  let line = '', yy = y;
  for (const word of text.split(/\s+/)) { const t = line ? `${line} ${word}` : word; if (g.measureText(t).width > w && line) { g.fillText(line, x, yy); line = word; yy += lh; } else line = t; }
  if (line) g.fillText(line, x, yy);
}
