import { z } from 'zod';

/**
 * Strict CSP (ADR-0040, ADR-0043): without `jitless`, Zod probes `new Function("")` for a faster object parser, and the
 * browser reports that probe as a `script-src` violation even though Zod catches the error (found by the Playwright CSP
 * check). Zod decides when each schema is constructed, so this module must be evaluated before
 * `@pulsegate/admin-contract`: it is the first import of main.tsx (guarded by main.test.ts).
 */
z.config({ jitless: true });
