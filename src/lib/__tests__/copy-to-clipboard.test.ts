/**
 * The copy helper behind every "Copy invite link" / "Copy circle ID" button.
 * Runs in the default node environment with hand-rolled navigator/document
 * stubs, so the fallback order is pinned without a DOM package.
 */
import { copyToClipboard, manualCopyMessage } from '../copy-to-clipboard';

const LINK = 'https://njangionchain.com/circle/0xabc/join';

type Stub = { clipboard?: { writeText: jest.Mock } };
const g = globalThis as unknown as { navigator?: Stub; document?: unknown };

function stubDocument(execResult: boolean | undefined) {
  const created: Array<Record<string, unknown>> = [];
  const body = { appendChild: jest.fn(), removeChild: jest.fn() };
  const doc: Record<string, unknown> = {
    body,
    createElement: jest.fn(() => {
      const el = { value: '', style: {}, setAttribute: jest.fn(), focus: jest.fn(), select: jest.fn(), setSelectionRange: jest.fn() };
      created.push(el);
      return el;
    }),
  };
  if (execResult !== undefined) doc.execCommand = jest.fn(() => execResult);
  g.document = doc;
  return { body, created, exec: doc.execCommand as jest.Mock | undefined };
}

afterEach(() => {
  delete g.navigator;
  delete g.document;
});

describe('copyToClipboard', () => {
  it('uses the Clipboard API when it works', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    g.navigator = { clipboard: { writeText } };
    stubDocument(true);
    await expect(copyToClipboard(LINK)).resolves.toBe('clipboard');
    expect(writeText).toHaveBeenCalledWith(LINK);
  });

  it('falls back to execCommand when the API throws (document not focused)', async () => {
    g.navigator = { clipboard: { writeText: jest.fn().mockRejectedValue(new Error('Document is not focused.')) } };
    const { body, created, exec } = stubDocument(true);
    await expect(copyToClipboard(LINK)).resolves.toBe('legacy');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(created[0].value).toBe(LINK);
    // cleans up the scratch textarea
    expect(body.removeChild).toHaveBeenCalledTimes(1);
  });

  it('falls back to execCommand when there is no Clipboard API (in-app browsers)', async () => {
    g.navigator = {};
    stubDocument(true);
    await expect(copyToClipboard(LINK)).resolves.toBe('legacy');
  });

  it('reports failure, without throwing, when both paths fail', async () => {
    g.navigator = { clipboard: { writeText: jest.fn().mockRejectedValue(new Error('denied')) } };
    stubDocument(false);
    await expect(copyToClipboard(LINK)).resolves.toBe('failed');
  });

  it('reports failure when there is no document to fall back to', async () => {
    g.navigator = {};
    await expect(copyToClipboard(LINK)).resolves.toBe('failed');
  });
});

describe('manualCopyMessage', () => {
  it('includes the text so the user can copy it by hand', () => {
    const msg = manualCopyMessage('invite link', LINK);
    expect(msg).toContain(LINK);
    expect(msg).toMatch(/press and hold/i);
  });
});
