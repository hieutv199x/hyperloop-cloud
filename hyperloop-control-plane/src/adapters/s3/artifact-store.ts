export interface ArtifactStore {
  putObject(uri: string, body: string | Uint8Array, contentType?: string): Promise<string>;
  getObject(uri: string): Promise<string>;
}

export class InMemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, string>();

  async putObject(uri: string, body: string | Uint8Array): Promise<string> {
    this.objects.set(uri, typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
    return uri;
  }

  async getObject(uri: string): Promise<string> {
    const value = this.objects.get(uri);
    if (value == null) {
      throw new Error(`Artifact not found: ${uri}`);
    }
    return value;
  }
}
