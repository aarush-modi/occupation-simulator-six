// Let teammates on the same network load the dev server from the host's LAN address (two-laptop play). Next blocks
// dev resources requested from other hostnames, which leaves a guest's page blank. Each `*` is one hostname label.
/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.*.*.*', '*.local'],
};

export default nextConfig;
