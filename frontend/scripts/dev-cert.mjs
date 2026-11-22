// Self-signed certificate for `npm run dev:https`, valid for localhost and this laptop's LAN addresses, so a
// teammate's browser treats the game as a secure page and allows the webcam. Browsers show a warning once per
// address (frontend and backend); nothing is added to the system's trusted certificates.
// Writes frontend/certificates/dev-key.pem and dev-cert.pem; regenerates when the LAN addresses change.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certificates');
const key = path.join(dir, 'dev-key.pem'), cert = path.join(dir, 'dev-cert.pem'), stamp = path.join(dir, 'dev-hosts.json');
const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
const hosts = ['localhost', '127.0.0.1', ...ips];

const current = fs.existsSync(stamp) && fs.existsSync(key) && fs.existsSync(cert) ? JSON.parse(fs.readFileSync(stamp, 'utf8')) : null;
if (current && hosts.every((h) => current.includes(h))) {
  console.log(`[dev-cert] reusing certificate for ${current.join(', ')}`);
} else {
  fs.mkdirSync(dir, { recursive: true });
  const san = hosts.map((h) => (/^\d+(\.\d+){3}$/.test(h) ? `IP:${h}` : `DNS:${h}`)).join(',');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30',
    '-keyout', key, '-out', cert, '-subj', '/CN=Workshift dev', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
  fs.writeFileSync(stamp, JSON.stringify(hosts));
  console.log(`[dev-cert] created a certificate for ${hosts.join(', ')}`);
}
