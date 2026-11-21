// Backend origin: NEXT_PUBLIC_BACKEND_URL, else port 3001 on whatever host served this page (so a guest who opened
// the LAN invite link reaches the host laptop's backend).
export function backendUrl() {
  const env = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (env) return env.replace(/\/$/, '');
  if (typeof window !== 'undefined') return `${window.location.protocol}//${window.location.hostname}:3001`;
  return 'http://localhost:3001';
}
export const BACKEND = backendUrl();
