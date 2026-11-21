// Let guests on the same network load the dev server from the host's LAN IP (two-laptop play, F5).
// Next matches only the Origin hostname; each `*` stands for one label of it.
/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.*.*.*', '*.local'],
};

export default nextConfig;
