// Workshift backend entry point. Run with `npm run dev` (loads .env via --env-file-if-exists).
// `npm run dev:https` (the --https flag) serves HTTPS and wss with the certificate frontend's dev:https creates, so a
// teammate's laptop can open the game as a secure page and use its webcam.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG } from './catalog.js';
import { loadDemos } from './demos.js';
import { createGenerator } from './generate.js';
import { createApp, lanAddress } from './app.js';

const port = Number(process.env.PORT ?? 3001);
const demos = loadDemos(CATALOG);
const generator = createGenerator({ catalog: CATALOG });
const certDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/certificates');
function devTls() {
  const key = path.join(certDir, 'dev-key.pem'), cert = path.join(certDir, 'dev-cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    throw new Error(`--https needs ${cert}. Start the frontend with "npm run dev:frontend:https" first; it creates the certificate.`);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
const tls = process.argv.includes('--https') ? devTls() : null;
const { server, secure } = createApp({ catalog: CATALOG, demos, generator, tls });

server.listen(port, '0.0.0.0', () => {
  console.log(`Workshift backend listening on ${secure ? 'https' : 'http'}://${lanAddress()}:${server.address().port}${secure ? ' (WebSockets: wss)' : ''}`);
  console.log(`catalog ${CATALOG.length} recipes, demos [${demos.map((d) => d.id).join(', ')}], model ${generator.model}${process.env.OPENAI_API_KEY ? '' : ' (OPENAI_API_KEY missing)'}`);
});
