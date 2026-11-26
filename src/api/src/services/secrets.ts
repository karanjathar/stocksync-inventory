import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface KeyEntry { version: number; key: Buffer }

/**
 * AES-256-GCM envelope for channel credentials. Layout: version (1 byte) | nonce (12) | auth tag (16) | ciphertext.
 * The business id is the associated data, so a ciphertext copied into another business's row fails authentication instead of decrypting.
 * Several keys can be loaded so that data written under an older key stays readable while it is re-encrypted after a rotation.
 */
export class SecretBox {
  private readonly keys = new Map<number, Buffer>();

  constructor(keys: KeyEntry[], private readonly currentVersion: number) {
    for (const { version, key } of keys) {
      if (!Number.isInteger(version) || version < 1 || version > 255) throw new Error('encryption key version must be 1–255');
      if (key.length !== 32) throw new Error('encryption keys must be exactly 32 bytes (AES-256)');
      this.keys.set(version, key);
    }
    if (!this.keys.has(currentVersion)) throw new Error('the current encryption key version is not among the loaded keys');
  }

  /** Builds the box from ENCRYPTION_KEY (+ _VERSION) and an optional ENCRYPTION_KEY_PREVIOUS ("<version>:<base64>"). Undefined when no key is configured. */
  static fromEnv(env: { ENCRYPTION_KEY?: string | undefined; ENCRYPTION_KEY_VERSION: number; ENCRYPTION_KEY_PREVIOUS?: string | undefined }): SecretBox | undefined {
    if (!env.ENCRYPTION_KEY) return undefined;
    const keys: KeyEntry[] = [{ version: env.ENCRYPTION_KEY_VERSION, key: Buffer.from(env.ENCRYPTION_KEY, 'base64') }];
    if (env.ENCRYPTION_KEY_PREVIOUS) {
      const [v, b64] = env.ENCRYPTION_KEY_PREVIOUS.split(':');
      keys.push({ version: Number(v), key: Buffer.from(b64 ?? '', 'base64') });
    }
    return new SecretBox(keys, env.ENCRYPTION_KEY_VERSION);
  }

  get version(): number { return this.currentVersion; }

  encrypt(plaintext: string, aad: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentVersion)!, nonce);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([this.currentVersion]), nonce, cipher.getAuthTag(), body]);
  }

  decrypt(blob: Buffer, aad: string): string {
    if (blob.length < 1 + 12 + 16) throw new Error('ciphertext too short');
    const key = this.keys.get(blob[0]!);
    if (!key) throw new Error('unknown encryption key version');
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8');
  }

  needsRotation(blob: Buffer): boolean {
    return blob.length > 0 && blob[0] !== this.currentVersion;
  }
}
