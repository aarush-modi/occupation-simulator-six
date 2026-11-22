'use client';
// The front door: one prompt bar over an explorable pixel field. Nothing else.
import { useRouter } from 'next/navigation';
import PixelSky from './ui/PixelSky';
import PromptBar from './ui/PromptBar';

export default function HomePage() {
  const router = useRouter();
  return (
    <main className="ws-screen">
      <PixelSky />
      <div className="ws-stage">
        <div className="ws-column">
          <h1 style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Workshift: try any job</h1>
          <PromptBar onStarted={(url) => router.push(url)} />
        </div>
      </div>
    </main>
  );
}
