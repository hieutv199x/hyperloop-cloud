import type { ArtifactStore } from './types.js';
import { parseS3Uri } from './types.js';

export class InMemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, string>();

  async putObject(uri: string, body: string | Uint8Array): Promise<string> {
    parseS3Uri(uri);
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
