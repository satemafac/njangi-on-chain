/**
 * Every WhatsApp Cloud API call uses one Graph API version, set in code.
 *
 * Until October 2026 each sender hardcoded its own `v23.0`, while the setup
 * docs and .env.example told operators to set WHATSAPP_API_VERSION=v21.0.
 * Only a module nothing imported read that variable. Wiring it into the
 * senders would have silently moved production back to v21.0, so
 * src/lib/whatsapp-graph-api.ts now holds the version and a bump is a reviewed
 * code change.
 *
 * This test greps the app code, so a new sender can't pin a version of its
 * own, and nothing can read WHATSAPP_API_VERSION again.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { WHATSAPP_GRAPH_API_VERSION } from '../whatsapp-graph-api';

const SENDERS = ['src/lib/whatsapp-notifier.ts', 'src/pages/api/whatsapp/webhook.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments explain the history; they must not trip the rule. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('WhatsApp Graph API version', () => {
  const files = walk(join(process.cwd(), 'src')).map((file) => ({
    path: relative(process.cwd(), file),
    code: stripComments(readFileSync(file, 'utf8')),
  }));

  it('is a Graph API version string', () => {
    expect(WHATSAPP_GRAPH_API_VERSION).toMatch(/^v\d+\.0$/);
  });

  it('builds every sender URL', () => {
    // Also guards against a walk() bug making the scans below vacuous.
    for (const sender of SENDERS) {
      const file = files.find((f) => f.path === sender);
      expect(file?.code).toMatch(/graph\.facebook\.com\/\$\{WHATSAPP_GRAPH_API_VERSION\}\//);
    }
  });

  it('is never hardcoded in a Graph API URL', () => {
    const offenders = files.filter((f) => /graph\.facebook\.com\/v\d/.test(f.code)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('never comes from WHATSAPP_API_VERSION', () => {
    const offenders = files.filter((f) => f.code.includes('WHATSAPP_API_VERSION')).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
