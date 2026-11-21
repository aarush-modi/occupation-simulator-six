'use client';
import { Suspense, useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import Rig from './Rig';
import People from './People';
import Player from './Player';
import Hud from './Hud';
import { Lighting, Ocean, PostFX } from './Look';

export default function Game() {
  const [quality, setQuality] = useState('high');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('quality');
    if (q) setQuality(q);
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <Canvas
        shadows="soft"
        flat
        dpr={[1, 2]}
        camera={{ fov: 72, near: 0.05, far: 5000, position: [-2, 1.65, 8] }}
        gl={{ antialias: false, powerPreference: 'high-performance' }}
      >
        <Suspense fallback={null}>
          <Lighting />
          <Ocean />
          <Rig />
          <People />
          <Player />
          <PostFX quality={quality} />
        </Suspense>
      </Canvas>
      <Hud />
    </div>
  );
}
