// The file packet: a small labelled card that arcs from one element to another. Pure presentation; instant when the
// user prefers reduced motion or chose Minimal.
// Tones: 'send' (to the table: everyone), 'person' (to one CLANmate only — labelled with their name), 'receive'.
export function flyPacket(from: Element | DOMRect, to: Element | DOMRect, label: string, opts: { tone?: 'send' | 'receive' | 'person' } = {}): Promise<void> {
  const a = from instanceof Element ? from.getBoundingClientRect() : from;
  const b = to instanceof Element ? to.getBoundingClientRect() : to;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.experience === 'minimal';
  if (still) return Promise.resolve();
  const el = Object.assign(document.createElement('div'), { className: `packet ${opts.tone ?? 'send'}`, textContent: label });
  el.setAttribute('aria-hidden', 'true');
  document.body.append(el);
  const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2, x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
  const lift = Math.min(160, Math.abs(x1 - x0) / 2 + 60);
  const anim = el.animate([
    { transform: `translate(${x0}px, ${y0}px) translate(-50%, -50%) scale(.9)`, opacity: 0, easing: 'ease-out' },
    { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - lift}px) translate(-50%, -50%) scale(1) rotate(-6deg)`, opacity: 1, offset: 0.5, easing: 'ease-in' },
    { transform: `translate(${x1}px, ${y1}px) translate(-50%, -50%) scale(.5)`, opacity: 0 },
  ], { duration: 850 });
  return anim.finished.then(() => el.remove(), () => el.remove());
}
