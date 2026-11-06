import { apiText } from './api/client';

/**
 * Opens a printable server-rendered document (invoice, packing slip, pick list) in a new tab.
 * Documents need the session token, so they are fetched with it and shown from a blob URL (a plain link could not send the token).
 */
export async function openDocument(path: string): Promise<void> {
  const html = await apiText(path);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const win = window.open(url, '_blank');
  if (!win) {
    URL.revokeObjectURL(url);
    throw new Error('The browser blocked the new tab. Allow pop-ups for this site to print documents.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
}
