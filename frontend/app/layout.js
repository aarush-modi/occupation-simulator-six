import { VT323 } from 'next/font/google';
import './ui/lobby.css';
import './ui/hud.css';

// Pixel type for the lobby screens; the 3D shift's HUD sets its own font.
const pixel = VT323({ weight: '400', subsets: ['latin'], variable: '--font-pixel', display: 'swap' });

export const metadata = {
  title: 'Workshift',
  description: 'Try an occupation in a motion-controlled 3D shift.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={pixel.variable} suppressHydrationWarning>
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
