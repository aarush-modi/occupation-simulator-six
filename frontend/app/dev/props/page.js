'use client';
import dynamic from 'next/dynamic';

const PropGallery = dynamic(() => import('../../../src/scene/dev/PropGallery'), { ssr: false });

export default function PropsPage() {
  return <PropGallery />;
}
