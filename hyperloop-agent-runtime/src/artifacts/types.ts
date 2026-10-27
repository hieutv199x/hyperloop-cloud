export interface ArtifactStore {
  putObject(uri: string, body: string | Uint8Array, contentType?: string): Promise<string>;
  getObject(uri: string): Promise<string>;
}

export function buildArtifactUri(bucket: string, key: string): string {
  const normalized = key.replace(/^\/+/, '');
  return `s3://${bucket}/${normalized}`;
}

export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    throw new Error(`Invalid S3 URI: ${uri}`);
  }
  return { bucket: match[1]!, key: match[2]! };
}
