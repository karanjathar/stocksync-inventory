import { randomUUID } from 'node:crypto';
import { BlobSASPermissions, BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { NotConfiguredError } from '../domain/errors.js';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const ALLOWED_IMAGE_TYPES = Object.keys(EXT) as [string, ...string[]];
const SAS_TTL_MS = 10 * 60_000;

/** Azure Blob Storage: the browser uploads straight to Blob with a short-lived, write-only SAS URL. */
export class ImageStorage {
  private readonly container?: ContainerClient;

  constructor(connectionString: string | undefined, containerName: string) {
    if (connectionString) {
      this.container = BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
    }
  }

  isConfigured(): boolean { return Boolean(this.container); }

  /** Origin of the Blob endpoint (Azure, custom domain or Azurite) for the Content-Security-Policy. */
  origin(): string | undefined {
    return this.container ? new URL(this.container.url).origin : undefined;
  }

  /** Creates the container with anonymous read on blobs so the public shop can show images. */
  async ensureContainer(): Promise<void> {
    await this.container?.createIfNotExists({ access: 'blob' });
  }

  /** Deletes every image of one business (they all live under its id). Returns how many were removed. Not exercised against live storage in tests. */
  async deleteTenantImages(tenantId: string): Promise<number> {
    if (!this.container || !/^[0-9a-f-]{36}$/i.test(tenantId)) return 0;
    let n = 0;
    for await (const blob of this.container.listBlobsFlat({ prefix: `${tenantId}/` })) { await this.container.deleteBlob(blob.name); n++; }
    return n;
  }

  /** Blobs are named `<businessId>/<year>/<random>.<ext>`: unguessable, and one prefix per business for export and deletion. */
  async createUploadSas(contentType: string, tenantId: string): Promise<{ uploadUrl: string; blobUrl: string }> {
    if (!this.container) throw new NotConfiguredError('Azure Blob Storage');
    const ext = EXT[contentType];
    if (!ext) throw new NotConfiguredError(`Uploads of ${contentType}`);
    const blob = this.container.getBlockBlobClient(`${tenantId}/${new Date().getUTCFullYear()}/${randomUUID()}.${ext}`);
    const uploadUrl = await blob.generateSasUrl({
      permissions: BlobSASPermissions.parse('cw'),
      startsOn: new Date(Date.now() - 60_000), // tolerate small clock skew
      expiresOn: new Date(Date.now() + SAS_TTL_MS),
      contentType,
    });
    return { uploadUrl, blobUrl: blob.url };
  }
}
