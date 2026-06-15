/**
 * Legal markdown rendering (June 2026 legal surface): the /legal pages render
 * docs/legal-drafts/*.{en,fr}.md at build time through the dependency-free
 * renderer in src/lib/legal-acceptance.ts. These tests pin the renderer's
 * behaviour on the constructs the drafts actually use (frontmatter, headings,
 * blockquote DRAFT banner, bold, inline code, lists, tables) and verify the
 * real draft files parse with the versions the app expects.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CURRENT_LEGAL_VERSIONS,
  LEGAL_DOC_IDS,
  LEGAL_DOC_SOURCE_BASENAMES,
  isLegalDocId,
  isLegalLocale,
  formatEffectiveDate,
  parseFrontmatter,
  parseLegalMarkdown,
  renderLegalMarkdownBody,
} from '../legal-acceptance';

describe('parseFrontmatter', () => {
  it('extracts quoted and unquoted values and strips the block from the body', () => {
    const raw = [
      '---',
      'title: "Njangi On-Chain — Terms of Service"',
      'version: 1.0.0',
      'effective_date: "{{EFFECTIVE_DATE}}"',
      'language: en',
      '---',
      '',
      '# Terms of Service',
    ].join('\n');

    const { meta, body } = parseFrontmatter(raw);
    expect(meta.title).toBe('Njangi On-Chain — Terms of Service');
    expect(meta.version).toBe('1.0.0');
    expect(meta.effective_date).toBe('{{EFFECTIVE_DATE}}');
    expect(meta.language).toBe('en');
    expect(body).not.toContain('---');
    expect(body).toContain('# Terms of Service');
  });

  it('returns the raw text as body when no frontmatter exists', () => {
    const { meta, body } = parseFrontmatter('# Hello');
    expect(meta).toEqual({});
    expect(body).toBe('# Hello');
  });
});

describe('renderLegalMarkdownBody', () => {
  it('renders headings, paragraphs, bold, and inline code', () => {
    const html = renderLegalMarkdownBody(
      ['## 1. Section', '', 'A **bold** statement with `sub` code.'].join('\n'),
    );
    expect(html).toContain('<h2>1. Section</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>sub</code>');
  });

  it('renders the multi-line DRAFT blockquote as one blockquote', () => {
    const html = renderLegalMarkdownBody(
      [
        '> **DRAFT — requires review by qualified counsel before publication.**',
        '> This document is a professional draft prepared for internal review.',
      ].join('\n'),
    );
    expect(html.match(/<blockquote>/g)).toHaveLength(1);
    expect(html).toContain('<strong>DRAFT — requires review by qualified counsel before publication.</strong>');
  });

  it('renders unordered and ordered lists', () => {
    const html = renderLegalMarkdownBody(
      ['- first item', '- second item', '', '1. step one', '2. step two'].join('\n'),
    );
    expect(html).toContain('<ul><li>first item</li><li>second item</li></ul>');
    expect(html).toContain('<ol><li>step one</li><li>step two</li></ol>');
  });

  it('renders pipe tables with a header row and skips the separator', () => {
    const html = renderLegalMarkdownBody(
      [
        '| Category | Examples |',
        '|---|---|',
        '| **OAuth identity** | `sub`, `aud` |',
      ].join('\n'),
    );
    expect(html).toContain('<th>Category</th>');
    expect(html).toContain('<td><strong>OAuth identity</strong></td>');
    expect(html).toContain('<code>sub</code>');
    expect(html).not.toContain('---');
  });

  it('escapes raw HTML so rendered output is injection-safe', () => {
    const html = renderLegalMarkdownBody('Evil <script>alert("x")</script> & <b>tags</b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('joins wrapped lines into a single paragraph', () => {
    const html = renderLegalMarkdownBody(['line one', 'line two'].join('\n'));
    expect(html).toBe('<p>line one line two</p>');
  });
});

describe('real legal drafts', () => {
  const draftsDir = path.join(process.cwd(), 'docs', 'legal-drafts');

  it.each(
    LEGAL_DOC_IDS.flatMap((doc) =>
      (['en', 'fr'] as const).map((locale) => [doc, locale] as const),
    ),
  )('%s (%s) parses with the expected version and a DRAFT banner', (doc, locale) => {
    const file = path.join(draftsDir, `${LEGAL_DOC_SOURCE_BASENAMES[doc]}.${locale}.md`);
    const render = parseLegalMarkdown(readFileSync(file, 'utf8'));

    expect(render.version).toBe(CURRENT_LEGAL_VERSIONS[doc]);
    expect(render.language).toBe(locale);
    expect(render.title).toContain('Njangi On-Chain');
    // The DRAFT banner blockquote must survive rendering until counsel signs off.
    expect(render.html).toContain('<blockquote>');
    expect(render.html).toContain('DRAFT');
    // No unescaped angle brackets from source should survive as stray tags.
    expect(render.html).not.toMatch(/<(?!\/?(h[1-6]|p|ul|ol|li|blockquote|table|thead|tbody|tr|th|td|strong|code)\b)/);
  });

  it('renders the privacy policy data table', () => {
    const render = parseLegalMarkdown(
      readFileSync(path.join(draftsDir, 'privacy-policy.en.md'), 'utf8'),
    );
    expect(render.html).toContain('<table>');
    expect(render.html).toContain('<th>Category</th>');
  });
});

describe('helpers', () => {
  it('isLegalDocId / isLegalLocale narrow correctly', () => {
    expect(isLegalDocId('terms')).toBe(true);
    expect(isLegalDocId('yield')).toBe(false);
    expect(isLegalLocale('fr')).toBe(true);
    expect(isLegalLocale('pcm')).toBe(false);
  });

  it('formatEffectiveDate maps unresolved placeholders to a draft label', () => {
    expect(formatEffectiveDate('{{EFFECTIVE_DATE}}', 'en')).toContain('draft');
    expect(formatEffectiveDate('{{EFFECTIVE_DATE}}', 'fr')).toContain('projet');
    expect(formatEffectiveDate('2026-07-01', 'en')).toBe('2026-07-01');
    expect(formatEffectiveDate(undefined, 'en')).toContain('draft');
  });
});
