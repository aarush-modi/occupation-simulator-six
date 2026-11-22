'use client';
// World-anchored DOM labels (name tags, station signs, CLOSED signs). One overlay outside the canvas; a projector
// inside the canvas writes each label's screen transform directly to its element every frame (no React renders).
import * as THREE from 'three';
import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';

const labels = new Map(); // id -> { pos: () => [x,y,z] | null, title, sub, color, variant, el }
const subs = new Set();
const notify = () => { for (const cb of subs) cb(); };

/** Register a world label for the lifetime of the calling component. `pos` is read every frame. */
export function useLabel(id, spec) {
  const ref = useRef(spec);
  ref.current = spec;
  useEffect(() => {
    if (!spec) return undefined;
    labels.set(id, { ...spec, pos: () => ref.current?.pos?.() ?? null });
    notify();
    return () => { labels.delete(id); notify(); };
  }, [id, spec?.title, spec?.sub, spec?.color, spec?.variant]); // eslint-disable-line react-hooks/exhaustive-deps
}

const v = new THREE.Vector3();
export function LabelProjector() {
  useFrame(({ camera, size }) => {
    for (const l of labels.values()) {
      const el = l.el;
      if (!el) continue;
      const p = l.pos();
      if (!p) { el.style.display = 'none'; continue; }
      v.set(p[0], p[1], p[2]);
      const d = v.distanceTo(camera.position);
      v.project(camera);
      if (v.z > 1 || d > 16 || Math.abs(v.x) > 1.3 || Math.abs(v.y) > 1.3) { el.style.display = 'none'; continue; }
      const x = (v.x * 0.5 + 0.5) * size.width, y = (-v.y * 0.5 + 0.5) * size.height;
      const s = Math.min(1, Math.max(0.72, 4 / Math.max(d, 0.1)));
      el.style.display = 'block';
      el.style.opacity = String(Math.min(1, Math.max(0, (16 - d) / 4)));
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${s.toFixed(3)})`;
      el.style.zIndex = String(1000 - Math.round(d * 10));
    }
  });
  return null;
}


function Label({ l }) {
  if (l.variant === 'closed') {
    return <div style={{ background: '#c9150b', color: '#fff', fontWeight: 900, letterSpacing: 3, fontSize: 14, padding: '4px 12px', borderRadius: 0, boxShadow: '0 2px 10px rgba(0,0,0,0.45)' }}>CLOSED</div>;
  }
  const sign = l.variant === 'sign';
  return (
    <div style={{ textAlign: 'center', padding: sign ? '3px 9px' : '4px 11px', borderRadius: 0, background: sign ? 'rgba(12,12,14,0.55)' : 'rgba(12,12,14,0.74)', boxShadow: '0 0 0 2px rgba(18,14,11,0.8), 0 3px 0 2px rgba(18,14,11,0.6)', color: '#fff', lineHeight: 1.2 }}>
      <div style={{ fontSize: sign ? 12 : 14, fontWeight: sign ? 600 : 700, color: sign ? '#dfe7ee' : '#fff' }}>
        <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 0, background: l.color ?? '#f2b233', marginRight: 6, verticalAlign: 1 }} />{l.title}
      </div>
      {l.sub && <div style={{ fontSize: 11, color: '#b9b4ad' }}>{l.sub}</div>}
    </div>
  );
}

export function LabelLayer() {
  const [, force] = useState(0);
  useEffect(() => { const cb = () => force((x) => x + 1); subs.add(cb); return () => subs.delete(cb); }, []);
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', fontFamily: "var(--font-pixel), ui-monospace, monospace", fontSizeAdjust: 0.56, zIndex: 5 }}>
      {[...labels.entries()].map(([id, l]) => (
        <div key={id} ref={(el) => { l.el = el; }} style={{ position: 'absolute', left: 0, top: 0, display: 'none', whiteSpace: 'nowrap', transformOrigin: '50% 100%', willChange: 'transform' }}>
          <Label l={l} />
        </div>
      ))}
    </div>
  );
}
