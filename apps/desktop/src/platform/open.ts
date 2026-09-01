/**
 * Open a link in the user's real browser.
 *
 * Inside the Tauri window a plain `target="_blank"` goes nowhere — the webview
 * has no tabs to open — so the native opener is used when it is present, and a
 * normal `window.open` when the same build runs in a browser during dev.
 */
export async function openExternal(url: string): Promise<void> {
  // Only http(s) ever reaches the OS handler. A `file:` or custom-scheme URL
  // arriving from alert payload data must not be handed to the shell.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(parsed.href);
    return;
  }
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}
