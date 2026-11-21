// Workshift backend entry point. Run with `npm run dev` (loads .env via --env-file-if-exists).
import { CATALOG } from './catalog.js';
import { loadDemos } from './demos.js';
import { createGenerator } from './generate.js';
import { createApp, lanAddress } from './app.js';

const port = Number(process.env.PORT ?? 3001);
const demos = loadDemos(CATALOG);
const generator = createGenerator({ catalog: CATALOG });
const { server } = createApp({ catalog: CATALOG, demos, generator });

server.listen(port, '0.0.0.0', () => {
  console.log(`Workshift backend listening on http://${lanAddress()}:${server.address().port}`);
  console.log(`catalog ${CATALOG.length} recipes, demos [${demos.map((d) => d.id).join(', ')}], model ${generator.model}${process.env.GEMINI_API_KEY ? '' : ' (GEMINI_API_KEY missing)'}`);
});
