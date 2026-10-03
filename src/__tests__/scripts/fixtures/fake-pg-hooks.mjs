// Loaded with `node --import`: resolves the bare specifier 'pg' to
// fake-pg.mjs, so a script under test can never reach a real database.
import { registerHooks } from 'node:module';

const fakePg = new URL('./fake-pg.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'pg' ? { url: fakePg, shortCircuit: true } : nextResolve(specifier, context);
  },
});
