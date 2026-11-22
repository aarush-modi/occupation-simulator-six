'use client';
import dynamic from 'next/dynamic';

const ShiftApp = dynamic(() => import('../../src/engine/ShiftApp'), { ssr: false });

export default function ShiftPage() {
  return <ShiftApp />;
}
