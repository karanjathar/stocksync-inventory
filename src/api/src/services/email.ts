import { createHash, createHmac } from 'node:crypto';
import type { Logger } from 'pino';

export interface EmailMessage { to: string; subject: string; text: string }
/** Outbound email. Injectable so tests and local runs never send real mail. */
export interface EmailSender { send(message: EmailMessage): Promise<void> }

/** Keeps messages in memory (tests). */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> { this.sent.push(message); }
}

/** Used when no email service is configured. Outside production the text is logged so a developer can follow the link; in production only the fact is. */
export class LogEmailSender implements EmailSender {
  constructor(private readonly logger: Logger, private readonly showBody: boolean) {}
  async send(m: EmailMessage): Promise<void> {
    this.logger.warn({ subject: m.subject, ...(this.showBody ? { to: m.to, text: m.text } : {}) }, 'email not sent: no email service configured (EMAIL_CONNECTION_STRING)');
  }
}

/** Azure Communication Services Email over its REST API (HMAC-SHA256 signed). Not exercised against the live service in this repository's tests. */
export class AcsEmailSender implements EmailSender {
  private readonly endpoint: string;
  private readonly key: Buffer;
  constructor(connectionString: string, private readonly from: string, private readonly doFetch: typeof fetch = fetch) {
    const parts = new Map(connectionString.split(';').filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i).toLowerCase(), p.slice(i + 1)] as const; }));
    const endpoint = parts.get('endpoint'); const key = parts.get('accesskey');
    if (!endpoint || !key) throw new Error('EMAIL_CONNECTION_STRING must look like endpoint=https://<name>.communication.azure.com/;accesskey=<key>');
    this.endpoint = endpoint.replace(/\/+$/, ''); this.key = Buffer.from(key, 'base64');
  }
  async send(m: EmailMessage): Promise<void> {
    const body = JSON.stringify({ senderAddress: this.from, recipients: { to: [{ address: m.to }] }, content: { subject: m.subject, plainText: m.text } });
    const pathAndQuery = '/emails:send?api-version=2023-03-31';
    const host = new URL(this.endpoint).host;
    const date = new Date().toUTCString();
    const contentHash = createHash('sha256').update(body).digest('base64');
    const signature = createHmac('sha256', this.key).update(`POST\n${pathAndQuery}\n${date};${host};${contentHash}`).digest('base64');
    const res = await this.doFetch(`${this.endpoint}${pathAndQuery}`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-ms-date': date, 'x-ms-content-sha256': contentHash,
        authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}` },
    });
    if (!res.ok) throw new Error(`email service answered ${res.status}`);
  }
}
