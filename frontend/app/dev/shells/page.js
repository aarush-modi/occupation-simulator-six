'use client';
import dynamic from 'next/dynamic';

const ShellViewer = dynamic(() => import('../../../src/scene/dev/ShellViewer'), { ssr: false });

export default function ShellsPage() {
  return <ShellViewer />;
}
