// Procedural canvas textures for room shells (no downloads). Every painter is deterministic (seeded) and cached.
// A texture covers `span` meters; geometry UVs are world-space meters / span (see uvWorld in Shell.jsx).
import * as THREE from 'three';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (c) => new THREE.Color(c);
function shade(c, k) {
  const col = hex(c);
  const hsl = {};
  col.getHSL(hsl);
  col.setHSL(hsl.h, hsl.s, THREE.MathUtils.clamp(hsl.l * k, 0, 1));
  return '#' + col.getHexString();
}
function jitter(c, r, amt) {
  return shade(c, 1 + (r() - 0.5) * 2 * amt);
}

function make(px, py = px) {
  const c = document.createElement('canvas');
  c.width = px;
  c.height = py;
  return [c, c.getContext('2d')];
}

// Soft mottling: many low-alpha radial blobs, wrapped so the texture tiles seamlessly.
function mottle(g, w, h, r, { n = 60, size = 0.25, alpha = 0.06, light = '#ffffff', dark = '#000000' } = {}) {
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h, rad = (0.3 + r()) * size * w;
    const col = r() > 0.5 ? light : dark;
    for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
      gr.addColorStop(0, hexA(col, alpha * r()));
      gr.addColorStop(1, hexA(col, 0));
      g.fillStyle = gr;
      g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
    }
  }
}
function hexA(c, a) {
  const col = hex(c);
  return `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`;
}
function speckle(g, w, h, r, { n = 4000, colors = ['#000'], min = 0.5, max = 1.5, alpha = 0.25 } = {}) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = hexA(colors[Math.floor(r() * colors.length)], alpha * (0.4 + r() * 0.6));
    const s = min + r() * (max - min);
    g.fillRect(r() * w, r() * h, s, s);
  }
}
// Fine per-pixel grain without a pixel loop over the whole canvas in JS strings.
function grain(g, w, h, r, amt = 10) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

function toTex(canvas, { srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---- painters: each returns { map, bump?, rough? } canvases for one tile of `span` meters ----

// Grid tiles. aspect = tile width / height; offset = running-bond shift per row (subway, blocks).
function tiles({ seed = 1, px = 1024, nx = 4, ny = 4, color, vary = 0.05, grout = '#999', groutPx = 6, offset = 0, bevel = 0.35, speck }) {
  const r = rng(seed);
  const [c, g] = make(px);
  const [b, gb] = make(px);
  g.fillStyle = grout; g.fillRect(0, 0, px, px);
  gb.fillStyle = '#000'; gb.fillRect(0, 0, px, px);
  const tw = px / nx, th = px / ny;
  for (let j = 0; j < ny; j++) {
    const shift = (j % 2) * offset * tw;
    for (let i = -1; i < nx + 1; i++) {
      const x = i * tw + shift, y = j * th;
      const col = Array.isArray(color) ? color[Math.floor(r() * color.length)] : color;
      g.fillStyle = jitter(col, r, vary);
      g.fillRect(x + groutPx / 2, y + groutPx / 2, tw - groutPx, th - groutPx);
      // glaze highlight toward the top-left, slight edge darkening
      const gr = g.createLinearGradient(x, y, x + tw, y + th);
      gr.addColorStop(0, 'rgba(255,255,255,0.05)');
      gr.addColorStop(1, 'rgba(0,0,0,0.05)');
      g.fillStyle = gr;
      g.fillRect(x + groutPx / 2, y + groutPx / 2, tw - groutPx, th - groutPx);
      // bump: raised tile with a rounded edge
      const e = groutPx * (1 + bevel * 2);
      gb.fillStyle = '#9a9a9a'; gb.fillRect(x + groutPx / 2, y + groutPx / 2, tw - groutPx, th - groutPx);
      gb.fillStyle = '#ffffff'; gb.fillRect(x + e, y + e, tw - 2 * e, th - 2 * e);
    }
  }
  if (speck) speckle(g, px, px, r, speck);
  mottle(g, px, px, r, { n: 30, size: 0.3, alpha: 0.05 });
  grain(g, px, px, r, 6);
  return { map: c, bump: b };
}

function planks({ seed = 2, px = 1024, n = 8, color, vary = 0.1, gap = '#2a1a10' }) {
  const r = rng(seed);
  const [c, g] = make(px);
  const [b, gb] = make(px);
  g.fillStyle = gap; g.fillRect(0, 0, px, px);
  gb.fillStyle = '#000'; gb.fillRect(0, 0, px, px);
  const pw = px / n; // planks run along v (texture y)
  for (let i = 0; i < n; i++) {
    let y = -r() * px;
    while (y < px) {
      const len = px * (0.35 + r() * 0.5);
      const base = jitter(color, r, vary);
      const x = i * pw;
      for (const oy of [0, px]) {
        const yy = y - oy;
        g.fillStyle = base;
        g.fillRect(x + 1.5, yy + 1.5, pw - 3, len - 3);
        // grain: long wavy strokes
        g.save();
        g.beginPath(); g.rect(x + 1.5, yy + 1.5, pw - 3, len - 3); g.clip();
        for (let k = 0; k < 14; k++) {
          g.strokeStyle = hexA(r() > 0.5 ? '#000000' : '#ffffff', 0.04 + r() * 0.06);
          g.lineWidth = 0.6 + r() * 1.6;
          g.beginPath();
          const gx = x + r() * pw;
          g.moveTo(gx, yy);
          for (let s = 0; s <= 8; s++) g.lineTo(gx + Math.sin(s * 0.9 + k) * (1 + r() * 3), yy + (len * s) / 8);
          g.stroke();
        }
        if (r() > 0.7) { // knot
          g.fillStyle = hexA('#2a1608', 0.25);
          g.beginPath(); g.ellipse(x + pw * (0.3 + r() * 0.4), yy + len * r(), 3 + r() * 4, 6 + r() * 8, 0, 0, Math.PI * 2); g.fill();
        }
        g.restore();
        gb.fillStyle = '#ffffff'; gb.fillRect(x + 2, yy + 2, pw - 4, len - 4);
      }
      y += len;
    }
  }
  grain(g, px, px, r, 8);
  return { map: c, bump: b };
}

function concrete({ seed = 3, px = 1024, color = '#8a8782', joints = true, stains = 0, lines }) {
  const r = rng(seed);
  const [c, g] = make(px);
  const [b, gb] = make(px);
  g.fillStyle = color; g.fillRect(0, 0, px, px);
  mottle(g, px, px, r, { n: 140, size: 0.18, alpha: 0.09 });
  speckle(g, px, px, r, { n: 9000, colors: ['#3a3835', '#d8d4cc'], min: 0.6, max: 2.2, alpha: 0.25 });
  for (let i = 0; i < stains; i++) mottle(g, px, px, r, { n: 2, size: 0.12 + r() * 0.1, alpha: 0.45, light: '#1c1a17', dark: '#2a2520' });
  grain(g, px, px, r, 10);
  gb.fillStyle = '#ffffff'; gb.fillRect(0, 0, px, px);
  speckle(gb, px, px, r, { n: 3000, colors: ['#000'], min: 0.8, max: 2, alpha: 0.4 });
  if (joints) {
    for (const ctx of [g, gb]) {
      ctx.fillStyle = ctx === g ? 'rgba(30,28,26,0.75)' : '#000';
      ctx.fillRect(0, 0, px, 3); ctx.fillRect(0, 0, 3, px);
    }
  }
  if (lines) lines(g, px);
  return { map: c, bump: b };
}

function carpet({ seed = 4, px = 512, color = '#3d4148', alt = '#353940' }) {
  const r = rng(seed);
  const [c, g] = make(px);
  const h = px / 2;
  // carpet tiles laid quarter-turned: alternate stripe directions
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    g.fillStyle = (i + j) % 2 ? color : alt;
    g.fillRect(i * h, j * h, h, h);
    g.save(); g.beginPath(); g.rect(i * h, j * h, h, h); g.clip();
    for (let k = 0; k < 80; k++) {
      g.fillStyle = hexA(r() > 0.5 ? '#ffffff' : '#000000', 0.035);
      if ((i + j) % 2) g.fillRect(i * h, j * h + k * (h / 80), h, 1.2);
      else g.fillRect(i * h + k * (h / 80), j * h, 1.2, h);
    }
    g.restore();
  }
  speckle(g, px, px, r, { n: 26000, colors: ['#000000', '#8c939e', '#5a6270'], min: 0.6, max: 1.4, alpha: 0.35 });
  grain(g, px, px, r, 18);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, 0, px, 1); g.fillRect(0, h, px, 1); g.fillRect(0, 0, 1, px); g.fillRect(h, 0, 1, px);
  return { map: c, bump: c };
}

// Seamless resin / vinyl / terrazzo: base colour plus chips.
function chips({ seed = 5, px = 1024, color, chipColors, n = 6000, min = 0.8, max = 2.5, alpha = 0.5, mott = 0.05 }) {
  const r = rng(seed);
  const [c, g] = make(px);
  g.fillStyle = color; g.fillRect(0, 0, px, px);
  mottle(g, px, px, r, { n: 60, size: 0.25, alpha: mott });
  for (let i = 0; i < n; i++) {
    g.fillStyle = hexA(chipColors[Math.floor(r() * chipColors.length)], alpha * (0.5 + r() * 0.5));
    const s = min + r() * (max - min);
    g.beginPath();
    g.ellipse(r() * px, r() * px, s, s * (0.5 + r() * 0.5), r() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  grain(g, px, px, r, 5);
  return { map: c };
}

function plaster({ seed = 6, px = 512, color }) {
  const r = rng(seed);
  const [c, g] = make(px);
  g.fillStyle = color; g.fillRect(0, 0, px, px);
  mottle(g, px, px, r, { n: 90, size: 0.2, alpha: 0.035 });
  grain(g, px, px, r, 5);
  const [b, gb] = make(px);
  gb.fillStyle = '#808080'; gb.fillRect(0, 0, px, px);
  mottle(gb, px, px, r, { n: 120, size: 0.05, alpha: 0.25 });
  grain(gb, px, px, r, 30);
  return { map: c, bump: b };
}

// 600 mm acoustic ceiling tiles in a white T-bar grid (texture = 2 x 2 tiles).
function ceilingGrid({ seed = 7, px = 512, color = '#ecebe6' }) {
  const r = rng(seed);
  const [c, g] = make(px);
  const [b, gb] = make(px);
  g.fillStyle = color; g.fillRect(0, 0, px, px);
  speckle(g, px, px, r, { n: 9000, colors: ['#9a9890', '#b8b6ae'], min: 0.6, max: 1.8, alpha: 0.5 });
  gb.fillStyle = '#ffffff'; gb.fillRect(0, 0, px, px);
  speckle(gb, px, px, r, { n: 9000, colors: ['#000'], min: 0.6, max: 1.8, alpha: 0.5 });
  const h = px / 2;
  for (const ctx of [g, gb]) {
    ctx.fillStyle = ctx === g ? '#f7f7f4' : '#ffffff';
    for (const o of [0, h]) { ctx.fillRect(o - 5, 0, 10, px); ctx.fillRect(0, o - 5, px, 10); }
    ctx.fillStyle = ctx === g ? 'rgba(0,0,0,0.12)' : '#000';
    for (const o of [0, h]) { ctx.fillRect(o + 5, 0, 2, px); ctx.fillRect(0, o + 5, px, 2); }
  }
  g.fillStyle = '#f7f7f4';
  for (const o of [0, h, px]) { g.fillRect(o - 5, 0, 10, px); g.fillRect(0, o - 5, px, 10); }
  return { map: c, bump: b };
}

// Corrugated metal wall panels: vertical ribs.
function ribbed({ seed = 8, px = 512, color = '#c9ccce', n = 8 }) {
  const r = rng(seed);
  const [c, g] = make(px);
  const [b, gb] = make(px);
  const w = px / n;
  for (let i = 0; i < n; i++) {
    const gr = g.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    gr.addColorStop(0, shade(color, 0.86)); gr.addColorStop(0.25, shade(color, 1.06)); gr.addColorStop(0.5, shade(color, 1.0));
    gr.addColorStop(0.75, shade(color, 0.92)); gr.addColorStop(1, shade(color, 0.86));
    g.fillStyle = gr; g.fillRect(i * w, 0, w, px);
    const gb2 = gb.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    gb2.addColorStop(0, '#000'); gb2.addColorStop(0.2, '#fff'); gb2.addColorStop(0.8, '#fff'); gb2.addColorStop(1, '#000');
    gb.fillStyle = gb2; gb.fillRect(i * w, 0, w, px);
  }
  mottle(g, px, px, r, { n: 40, size: 0.3, alpha: 0.05 });
  grain(g, px, px, r, 6);
  return { map: c, bump: b };
}

const CACHE = new Map();
const PAINTERS = { tiles, planks, concrete, carpet, chips, plaster, ceilingGrid, ribbed };

// surfaceTextures('tiles', {...}) -> { map: Texture, bump?: Texture }
export function surfaceTextures(kind, opts = {}) {
  const key = kind + JSON.stringify(opts, (k, v) => (typeof v === 'function' ? v.toString() : v));
  let out = CACHE.get(key);
  if (!out) {
    const res = PAINTERS[kind](opts);
    out = { map: toTex(res.map), bump: res.bump ? toTex(res.bump, { srgb: false }) : null };
    CACHE.set(key, out);
  }
  return out;
}

// Drawn graphics (signs, posters, exterior views). draw(g, w, h) paints onto a w x h canvas.
export function paintedTexture(key, w, h, draw) {
  let t = CACHE.get('paint:' + key);
  if (!t) {
    const [c, g] = make(w, h);
    draw(g, w, h, rng(key.length * 97 + w));
    t = toTex(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    CACHE.set('paint:' + key, t);
  }
  return t;
}

export { rng, shade, hexA, mottle, speckle };
