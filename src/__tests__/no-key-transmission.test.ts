/**
 * The ephemeral signing key must never leave the browser.
 *
 * This is THE CLARITY property. The server can mint a salt and a zkProof —
 * that is authentication, and a legitimate server role. It must not be able
 * to produce a signature, because an operator that can sign as the user has
 * "the unilateral technical ability to ... initiate transactions".
 *
 * Phase 1 moved key generation into the browser and everyone believed the
 * property held. It did not: WhatsAppCircleIntegration kept POSTing
 * `ephemeralPrivateKey` — alongside zkProofs, userSalt, sub, aud and
 * maxEpoch — to /api/whatsapp/admin-{link,unlink}-circle, which rebuilt the
 * keypair and signed. That is the complete set needed to sign ANY
 * transaction for that address until the epoch rolls, so the arbitrary
 * signing oracle deleted in Phase 0 was quietly still reachable.
 *
 * The ESLint guard did not catch it: its scope is `src/pages/api/**`, and
 * the signing primitives live in `src/services/enokiZkLoginService.ts` —
 * one directory over, imported BY the API routes. Grepping where the code
 * isn't proves nothing, so this test greps where the key would have to
 * appear for it to travel: client code that builds a request body.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/** Client trees. Anything here runs in the browser and may build requests. */
const CLIENT_DIRS = ['src/components', 'src/pages'];

/**
 * The browser legitimately handles the key — it generates, stores and signs
 * with it. These are the modules allowed to name it; none of them are under
 * a client tree, so the allowlist stays empty and is kept only to document
 * that the rule is about TRANSMISSION, not possession.
 */
const ALLOWED: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `src/pages/api` is server code, not a request builder.
      if (entry !== '__tests__' && entry !== 'api') walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments explain the rule; they must not trip it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('ephemeral key never leaves the browser', () => {
  const files = CLIENT_DIRS.flatMap((d) => walk(join(process.cwd(), d)));

  it('scans a meaningful number of client files', () => {
    // Guards against a walk() bug silently making this test vacuous.
    expect(files.length).toBeGreaterThan(20);
  });

  it('is never referenced in client code that builds a request', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(process.cwd(), file);
      if (ALLOWED.includes(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (/\bephemeralPrivateKey\b/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('no server-side module can build a signer at all', () => {
    // The other half of the property, and the half that was missing. The
    // eslint ban originally covered src/pages/api/** only, while the
    // primitives lived in src/services/enokiZkLoginService.ts — imported BY
    // those routes. "Zero hits under src/pages/api" was true and meaningless.
    //
    // Asserted here as well as in eslint because a lint rule can be disabled
    // inline; this cannot.
    const trees = [join(process.cwd(), 'src/pages/api'), join(process.cwd(), 'src/services')];
    const offenders: string[] = [];

    for (const file of trees.flatMap((t) => walk(t))) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const primitive of ['Ed25519Keypair', 'decodeSuiPrivateKey', 'getZkLoginSignature']) {
        // Ed25519PublicKey is legitimate — a public key cannot sign — so match
        // the keypair name on a word boundary rather than a bare substring.
        const re = new RegExp(`\\b${primitive}\\b`);
        if (re.test(code)) offenders.push(`${relative(process.cwd(), file)} -> ${primitive}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no server route reads a caller-supplied signing key', () => {
    // The mirror of the rule above: even if a client were to send one, no
    // route may consume it. Together these make the property double-sided.
    const routes = walk(join(process.cwd(), 'src/pages/api'));
    const offenders: string[] = [];
    for (const file of routes) {
      const code = stripComments(readFileSync(file, 'utf8'));
      // `account.ephemeralPrivateKey` / `session.ephemeralPrivateKey` reads.
      if (/\.\s*ephemeralPrivateKey\b/.test(code)) {
        offenders.push(relative(process.cwd(), file));
      }
    }
    // zkLogin.ts still carries the legacy v1 session shape; it is expected
    // here until the server-signing actions are deleted outright (Phase 6
    // end-state). Every OTHER route must be clean — that is what regressed.
    expect(offenders.filter((f) => !f.endsWith('api/zkLogin.ts'))).toEqual([]);
  });
});
