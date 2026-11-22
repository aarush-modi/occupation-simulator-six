'use client';
// The lobby backdrop: an endless, slowly drifting field of pixel-art workplace things (tools of many jobs).
// The pointer is a lantern: things near it light up and hop. Dragging the background pans the field.
import { useEffect, useRef } from 'react';

const PALETTE = {
  k: '#2a1f18', a: '#f2b233', c: '#f5e6c8', r: '#ff7a5c', g: '#8fd19e', b: '#7fc8f8',
  l: '#c9a7ff', p: '#ff9ec7', s: '#a9b6c3', w: '#fff7e6', n: '#a9703f', d: '#5b4636',
};

// 12 x 12 sprites. '.' is transparent.
const SPRITES = {
  coffee: [
    '....w..w....', '.....w..w...', '....w..w....', '............',
    '.kkkkkkkk...', '.kccccccckkk', '.kcnnnnnck.k', '.kccccccck.k',
    '.kccccccckkk', '.kccccccck..', '..kccccck...', '...kkkkk....'],
  wrench: [
    '........kk..', '.......kssk.', '.......ks.kk', '......ksssk.',
    '.....ksssk..', '....ksssk...', '...ksssk....', '..ksssk.....',
    '.kssk.......', 'ks.sk.......', 'kkssk.......', '.kkk........'],
  flower: [
    '....pppp....', '...pwwwwp...', '..pwwaawwp..', '..pwaaaawp..',
    '..pwwaawwp..', '...pwwwwp...', '....pppp....', '.....gg.....',
    '..ggg.g.....', '...gggg.....', '....dnnd....', '....dddd....'],
  box: [
    '............', '.kkkkkkkkkk.', '.knnnnannnk.', '.knnnnannnk.',
    '.kkkkkkkkkk.', '.knnnnannnk.', '.kncnnannnk.', '.kncnnannnk.',
    '.knnnnannnk.', '.knnnnannnk.', '.kkkkkkkkkk.', '............'],
  chefhat: [
    '...ww.ww....', '..wwwwwwww..', '.wwwwwwwwww.', '.wwwcwwwcww.',
    '.wwwwwwwwww.', '..wwwwwwww..', '...kkkkkk...', '...wwwwww...',
    '...wcwwcww..', '...wwwwww...', '...kkkkkk...', '............'],
  flask: [
    '....kkkk....', '.....ss.....', '.....ws.....', '.....ws.....',
    '....kssk....', '...ks..sk...', '..ks....sk..', '.ksggggggsk.',
    '.kgwgggggsk.', '.kggggwggsk.', '..kkkkkkkk..', '............'],
  heart: [
    '............', '..rr...rr...', '.rrrr.rrrr..', 'rrwrrrrrrrr.',
    'rwrrrrrrrrr.', 'rrrrrrrrrrr.', '.rrrrrrrrr..', '..rrrrrrr...',
    '...rrrrr....', '....rrr.....', '.....r......', '............'],
  scissors: [
    'k........k..', 'sk......ks..', '.sk....ks...', '..sk..ks....',
    '...skks.....', '....kk......', '...kaak.....', '..ka..ak....',
    '.ka....ak...', '.ka....ak...', '..kaaaak....', '...kkkk.....'],
  laptop: [
    '............', '..kkkkkkkk..', '..kbbbbbbk..', '..kbwbbbbk..',
    '..kbbbbbbk..', '..kbbbbbbk..', '..kkkkkkkk..', '.kssssssssk.',
    'kssksksksssk', 'kkkkkkkkkkkk', '............', '............'],
  hammer: [
    '..kkkkkk....', '.ksssssskk..', '.kssssssssk.', '..kkknkkkk..',
    '.....nk.....', '.....nk.....', '.....nk.....', '.....nk.....',
    '.....nk.....', '.....nk.....', '.....dk.....', '.....kk.....'],
  glove: [
    '...rrrrr....', '..rrrrrrr...', '.rrrwrrrrr..', '.rrrrrrrrr..',
    '.rrrrrrrrrr.', 'rrrrrrrrrrr.', 'rrrrrrrrrr..', '.rrrrrrrrr..',
    '..kkkkkkk...', '..wwwwwww...', '..kkkkkkk...', '............'],
  book: [
    '............', '.kkkkkkkkkk.', '.kllllllllk.', '.klwwwwwwlk.',
    '.kllllllllk.', '.klwwwwlllk.', '.kllllllllk.', '.kllllllllk.',
    '.kcccccccck.', '.kkkkkkkkkk.', '............', '............'],
  plant: [
    '.....g......', '...g.gg.g...', '..gggggggg..', '...gggwggg..',
    '..gggggggg..', '....gggg....', '.....gg.....', '...kkkkkk...',
    '...krrrrrk..', '....krrrk...', '....kkkkk...', '............'],
  stethoscope: [
    '.k......k...', '.s......s...', '.s......s...', '.s......s...',
    '..s....s....', '...ssss.....', '.....s......', '.....s...kk.',
    '.....s..kbbk', '......s.kbbk', '.......s.kk.', '............'],
};
const NAMES = Object.keys(SPRITES);
const TILE_W = 2200, TILE_H = 1500; // the field repeats in both directions

function bake(rows, scale) {
  const c = document.createElement('canvas');
  c.width = 12 * scale; c.height = 12 * scale;
  const g = c.getContext('2d');
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    g.fillStyle = PALETTE[ch];
    g.fillRect(x * scale, y * scale, scale, scale);
  }));
  return c;
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export default function PixelSky() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const g = canvas.getContext('2d');
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const rand = seeded(20261122);
    // Three depth layers: far things are small and dim, near things big and bright.
    const layers = [
      { depth: 0.35, scale: 3, count: 70, alpha: 0.32 },
      { depth: 0.65, scale: 4, count: 42, alpha: 0.55 },
      { depth: 1, scale: 6, count: 18, alpha: 0.9 },
    ];
    const baked = {};
    for (const { scale } of layers) for (const n of NAMES) baked[`${n}:${scale}`] = bake(SPRITES[n], scale);
    const things = layers.flatMap((layer) => Array.from({ length: layer.count }, () => ({
      ...layer, img: baked[`${NAMES[Math.floor(rand() * NAMES.length)]}:${layer.scale}`],
      x: rand() * TILE_W, y: rand() * TILE_H, phase: rand() * 6.28, speed: 0.6 + rand() * 0.9, hop: 0,
    })));
    const stars = Array.from({ length: 90 }, () => ({ x: rand() * TILE_W, y: rand() * TILE_H, phase: rand() * 10, depth: 0.2 + rand() * 0.3 }));

    let w = 0, h = 0, dpr = 1, raf = 0;
    const pointer = { x: -9999, y: -9999, nx: 0, ny: 0 };
    const cam = { x: 0, y: 0, vx: 0, vy: 0 };
    let drag = null;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.imageSmoothingEnabled = false;
    };
    const onMove = (e) => {
      pointer.x = e.clientX; pointer.y = e.clientY;
      pointer.nx = e.clientX / w - 0.5; pointer.ny = e.clientY / h - 0.5;
      if (drag) {
        cam.vx = drag.x - e.clientX; cam.vy = drag.y - e.clientY;
        cam.x += cam.vx; cam.y += cam.vy;
        drag = { x: e.clientX, y: e.clientY };
      }
    };
    const onDown = (e) => { if (e.target === canvas) { drag = { x: e.clientX, y: e.clientY }; canvas.style.cursor = 'grabbing'; } };
    const onUp = () => { drag = null; canvas.style.cursor = 'grab'; };
    const onLeave = () => { pointer.x = pointer.y = -9999; };

    const wrap = (v, size) => ((v % size) + size) % size;
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const t = now / 1000;
      if (!drag && !still) {
        // Drift on its own; a flung drag glides to a stop.
        cam.vx *= 0.92; cam.vy *= 0.92;
        cam.x += cam.vx + dt * 14; cam.y += cam.vy + dt * 5;
      }
      g.clearRect(0, 0, w, h);
      // Lantern glow under the pointer.
      if (pointer.x > -999) {
        const glow = g.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 260);
        glow.addColorStop(0, 'rgba(242,178,51,0.16)');
        glow.addColorStop(1, 'rgba(242,178,51,0)');
        g.fillStyle = glow;
        g.fillRect(0, 0, w, h);
      }
      for (const s of stars) {
        const on = still || Math.floor(t * 1.6 + s.phase) % 4 !== 0; // stepped twinkle
        if (!on) continue;
        g.fillStyle = 'rgba(255,240,210,0.5)';
        const x0 = wrap(s.x - cam.x * s.depth - pointer.nx * 40 * s.depth, TILE_W);
        const y0 = wrap(s.y - cam.y * s.depth - pointer.ny * 30 * s.depth, TILE_H);
        for (let x = x0; x < w + 4; x += TILE_W) for (let y = y0; y < h + 4; y += TILE_H) g.fillRect(Math.round(x), Math.round(y), 2, 2);
      }
      for (const it of things) {
        const par = it.depth;
        const x0 = wrap(it.x - cam.x * par - pointer.nx * 90 * par, TILE_W) - 80;
        const y0 = wrap(it.y - cam.y * par - pointer.ny * 60 * par, TILE_H) - 80;
        const size = it.img.width;
        const bob = still ? 0 : Math.round(Math.sin(t * it.speed + it.phase) * 1.5) * it.scale;
        let nearest = 0;
        for (let bx = x0; bx < w + 80; bx += TILE_W) {
          for (let by = y0; by < h + 80; by += TILE_H) {
            const near = Math.max(0, 1 - Math.hypot(bx + size / 2 - pointer.x, by + size / 2 - pointer.y) / 200);
            nearest = Math.max(nearest, near);
            const lift = Math.round(it.hop * 3) * it.scale; // hop in whole pixels
            g.globalAlpha = Math.min(1, it.alpha + near * 0.6);
            g.drawImage(it.img, Math.round(bx), Math.round(by + bob - lift));
          }
        }
        it.hop += ((nearest > 0.35 ? 1 : 0) - it.hop) * Math.min(1, dt * 10);
      }
      g.globalAlpha = 1;
      if (!still) raf = requestAnimationFrame(frame);
    };

    resize();
    canvas.style.cursor = 'grab';
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    document.addEventListener('pointerleave', onLeave);
    raf = requestAnimationFrame(frame);
    // Reduced motion: one still frame, redrawn when the lantern moves.
    const stillMove = () => requestAnimationFrame(frame);
    if (still) window.addEventListener('pointermove', stillMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointermove', stillMove);
    };
  }, []);
  return (
    <>
      <canvas ref={ref} className="ws-sky" aria-hidden="true" />
      <div className="ws-crt" aria-hidden="true" />
    </>
  );
}
