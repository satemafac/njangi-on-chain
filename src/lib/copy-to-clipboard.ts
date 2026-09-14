// copy-to-clipboard.ts — one copy routine for every "Copy invite link" /
// "Copy circle ID" button, with the fallbacks the raw Clipboard API lacks.
//
// `navigator.clipboard.writeText` fails in three situations that all
// present to the user as "Failed to copy invite link":
//   * the document is not focused (NotAllowedError) — split views, a tab
//     that lost focus to devtools or a picker, embedded/preview panes;
//   * there is no `navigator.clipboard` at all — in-app browsers (WhatsApp,
//     Instagram, Facebook) and older WebViews, exactly where invite links
//     get opened;
//   * the write is denied by permission policy.
// The legacy `execCommand('copy')` path works in most of those, so try it
// second. If both fail the caller must let the user copy by hand.

export type CopyOutcome = 'clipboard' | 'legacy' | 'failed';

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    return false;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  // Keep it in the layout (some engines refuse to copy from display:none)
  // but out of sight and out of the scroll position.
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.width = '1px';
  area.style.height = '1px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}

/**
 * Copies `text`, reporting which path worked. Never throws. Call it
 * synchronously from the click handler (no `await` before it) so the
 * user-activation the browser requires is still current.
 */
export async function copyToClipboard(text: string): Promise<CopyOutcome> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return 'clipboard';
    } catch {
      // fall through to the legacy path
    }
  }
  return legacyCopy(text) ? 'legacy' : 'failed';
}

/**
 * What to tell the user when both paths failed: the link itself, so it can
 * be selected and copied by hand, plus the one gesture that works in every
 * mobile browser.
 */
export function manualCopyMessage(label: string, text: string): string {
  return `Couldn't copy the ${label} automatically. Press and hold to copy it: ${text}`;
}
