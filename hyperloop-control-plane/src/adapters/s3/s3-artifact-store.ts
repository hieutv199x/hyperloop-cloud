import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ArtifactStore } from './artifact-store.js';

function parseS3Uri(uri: string): { bucket: string; key: string } {
  if (uri.startsWith('s3://')) {
    const without = uri.slice('s3://'.length);
    const slash = without.indexOf('/');
    if (slash <= 0) throw new Error(`Invalid S3 URI: ${uri}`);
    return { bucket: without.slice(0, slash), key: without.slice(slash + 1) };
  }
  throw new Error(`Artifact URI must be s3://bucket/key, got: ${uri}`);
}

export class S3ArtifactStore implements ArtifactStore {
  constructor(
    private readonly client: S3Client = new S3Client({}),
    private readonly defaultBucket?: string,
  ) {}

  async putObject(
    uri: string,
    body: string | Uint8Array,
    contentType = 'application/octet-stream',
  ): Promise<string> {
    const { bucket, key } = this.resolve(uri);
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
        ContentType: contentType,
      }),
    );
    return `s3://${bucket}/${key}`;
  }

  async getObject(uri: string): Promise<string> {
    const { bucket, key } = this.resolve(uri);
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty S3 object: ${uri}`);
    return Buffer.from(bytes).toString('utf8');
  }

  private resolve(uri: string): { bucket: string; key: string } {
    if (uri.startsWith('s3://')) return parseS3Uri(uri);
    if (!this.defaultBucket) {
      throw new Error(`Relative artifact key requires default bucket: ${uri}`);
    }
    return { bucket: this.defaultBucket, key: uri.replace(/^\//, '') };
  }
}
