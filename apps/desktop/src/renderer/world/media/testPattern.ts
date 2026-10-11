// TEST-ONLY capture source (development builds with CLAN_TEST_CAPTURE=1): a moving block, timestamp and frame counter,
// so automated tests can prove viewers receive *changing* frames. Never offered in packaged builds.
export function testPatternStream(variant: 'screen' | 'window', size: { w: number; h: number } = { w: 960, h: 540 }, fps = 15): MediaStream {
  const c = Object.assign(document.createElement('canvas'), { width: size.w, height: size.h });
  const g = c.getContext('2d')!;
  let f = 0;
  const draw = () => {
    g.fillStyle = variant === 'screen' ? '#17233b' : '#8a2d48'; g.fillRect(0, 0, size.w, size.h);
    g.fillStyle = '#f0b02f'; g.fillRect((f * 12) % (size.w - 100), size.h * 0.37, 100, 100);
    g.fillStyle = '#fffbf3'; g.font = 'bold 44px sans-serif'; g.fillText(`${variant.toUpperCase()} TEST PATTERN · frame ${f}`, 40, 80); g.fillText(new Date().toISOString().slice(11, 23), 40, size.h - 70);
    f++;
  };
  const stream = c.captureStream(0);
  const track = stream.getVideoTracks()[0]! as CanvasCaptureMediaStreamTrack;
  const frame = () => { draw(); track.requestFrame(); };
  frame();
  const t = setInterval(frame, Math.round(1000 / fps));
  stream.getVideoTracks()[0]!.addEventListener('ended', () => clearInterval(t));
  return stream;
}
