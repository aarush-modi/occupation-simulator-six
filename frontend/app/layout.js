export const metadata = {
  title: 'Workshift',
  description: 'Try an occupation in a motion-controlled 3D shift.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
