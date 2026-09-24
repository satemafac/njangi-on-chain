import { isAppPath, resolvePostLoginDestination } from '@/lib/post-login-redirect';

const ORIGIN = 'https://njangionchain.com';

describe('resolvePostLoginDestination', () => {
  it('accepts an app path', () => {
    expect(resolvePostLoginDestination('/create-circle', ORIGIN)).toBe('/create-circle');
    expect(resolvePostLoginDestination('/circle/0xabc/join', ORIGIN)).toBe('/circle/0xabc/join');
  });

  it('accepts a same-origin absolute URL (what the join page stores)', () => {
    const url = `${ORIGIN}/circle/0xabc/join?ref=wa`;
    expect(resolvePostLoginDestination(url, ORIGIN)).toBe(url);
    expect(resolvePostLoginDestination(ORIGIN, ORIGIN)).toBe('/');
  });

  it('rejects foreign origins, protocol-relative and look-alike hosts', () => {
    expect(resolvePostLoginDestination('https://evil.example/x', ORIGIN)).toBeNull();
    expect(resolvePostLoginDestination('//evil.example/x', ORIGIN)).toBeNull();
    expect(resolvePostLoginDestination('https://njangionchain.com.evil.example/', ORIGIN)).toBeNull();
    expect(resolvePostLoginDestination('javascript:alert(1)', ORIGIN)).toBeNull();
  });

  it('rejects empty and non-string values', () => {
    expect(resolvePostLoginDestination(null, ORIGIN)).toBeNull();
    expect(resolvePostLoginDestination(undefined, ORIGIN)).toBeNull();
    expect(resolvePostLoginDestination('', ORIGIN)).toBeNull();
    expect(resolvePostLoginDestination('   ', ORIGIN)).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(resolvePostLoginDestination('  /dashboard \n', ORIGIN)).toBe('/dashboard');
  });

  it('without a known origin only app paths pass', () => {
    expect(resolvePostLoginDestination('/create-circle', '')).toBe('/create-circle');
    expect(resolvePostLoginDestination(`${ORIGIN}/x`, '')).toBeNull();
  });
});

describe('isAppPath', () => {
  it('distinguishes app paths from absolute URLs', () => {
    expect(isAppPath('/create-circle')).toBe(true);
    expect(isAppPath(`${ORIGIN}/create-circle`)).toBe(false);
    expect(isAppPath('//x')).toBe(false);
  });
});
