// The prop catalog, imported once at startup (regenerate with `cd frontend && node scripts/catalog.mjs`).
import { CATALOG } from '../../frontend/src/shared/catalog/catalog.generated.js';

export { CATALOG };
export const RECIPES = new Map(CATALOG.map((r) => [r.id, r]));
