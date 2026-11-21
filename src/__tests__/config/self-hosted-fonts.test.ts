/**
 * Fonts are bundled under src/fonts and loaded with next/font/local, so a build never downloads a font.
 * next/font/google's loader throws on a Google font URL without a file extension
 * (loader.js: `/\.(woff|woff2|eot|ttf|otf)$/.exec(url)[1]`), which failed Vercel builds at random with
 * "Cannot read properties of null (reading '1')".
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' || name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx|js|jsx)$/.test(name) ? [full] : [];
  });
}

const files = sourceFiles(SRC);

describe('bundled fonts', () => {
  it('no source file loads a font from Google at build time', () => {
    const offenders = files.filter((f) => /from\s+['"]next\/font\/google['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('every bundled font a source file names exists, with its licence beside it', () => {
    const refs = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/['"]((?:\.\.\/)+fonts\/[^'"]+\.woff2)['"]/g)].map((m) => path.resolve(path.dirname(f), m[1]!)),
    );
    expect(refs.length).toBeGreaterThanOrEqual(6);
    for (const font of refs) {
      expect(existsSync(font)).toBe(true);
      expect(readFileSync(font).subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(existsSync(path.join(path.dirname(font), 'OFL.txt'))).toBe(true);
    }
  });
});
