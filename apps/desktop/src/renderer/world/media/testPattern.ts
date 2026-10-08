// TEST-ONLY capture source (development builds with CLAN_TEST_CAPTURE=1): a moving block, timestamp and frame counter,
// so automated tests can prove viewers receive *changing* frames. Never offered in packaged builds.
export function testPatternStream(variant: 'screen' | 'window'): MediaStream {
  const c = Object.assign(document.createElement('canvas'), { width: 960, height: 540 });
  const g = c.getContext('2d')!;
  let f = 0;
  const draw = () => {
    g.fillStyle = variant === 'screen' ? '#17233b' : '#8a2d48'; g.fillRect(0, 0, 960, 540);
    g.fillStyle = '#f0b02f'; g.fillRect((f * 12) % 860, 200, 100, 100);
    g.fillStyle = '#fffbf3'; g.font = 'bold 44px sans-serif'; g.fillText(`${variant.toUpperCase()} TEST PATTERN · frame ${f}`, 40, 80); g.fillText(new Date().toISOString().slice(11, 23), 40, 470);
    f++;
  };
  draw();
  const t = setInterval(draw, 66);
  const stream = c.captureStream(15);
  stream.getVideoTracks()[0]!.addEventListener('ended', () => clearInterval(t));
  return stream;
}
