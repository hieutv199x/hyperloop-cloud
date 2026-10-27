import type { DesiredJobSpec, KubernetesJobPort, ObservedJob } from './types.js';

export interface FakeKubernetesOptions {
  /** Fail N create attempts with timeout before succeeding. */
  createTimeoutFailures?: number;
  /** Track create attempts per job name. */
  failCreateForNames?: Set<string>;
}

export class FakeKubernetesAdapter implements KubernetesJobPort {
  private readonly jobs = new Map<string, ObservedJob>();
  readonly createCalls: string[] = [];
  private remainingTimeoutFailures: number;

  constructor(private readonly options: FakeKubernetesOptions = {}) {
    this.remainingTimeoutFailures = options.createTimeoutFailures ?? 0;
  }

  private key(namespace: string, name: string): string {
    return `${namespace}/${name}`;
  }

  async createJob(spec: DesiredJobSpec): Promise<ObservedJob> {
    this.createCalls.push(spec.name);

    if (this.remainingTimeoutFailures > 0) {
      this.remainingTimeoutFailures -= 1;
      throw new Error(`Kubernetes create timeout for ${spec.name}`);
    }

    if (this.options.failCreateForNames?.has(spec.name)) {
      throw new Error(`Kubernetes create failed for ${spec.name}`);
    }

    const existing = this.jobs.get(this.key(spec.namespace, spec.name));
    if (existing && existing.phase !== 'NotFound') {
      return existing;
    }

    const observed: ObservedJob = {
      name: spec.name,
      namespace: spec.namespace,
      phase: 'Pending',
      uid: `fake-${spec.name}`,
    };
    this.jobs.set(this.key(spec.namespace, spec.name), observed);
    return observed;
  }

  async getJob(namespace: string, name: string): Promise<ObservedJob> {
    return (
      this.jobs.get(this.key(namespace, name)) ?? {
        name,
        namespace,
        phase: 'NotFound',
      }
    );
  }

  async deleteJob(namespace: string, name: string): Promise<void> {
    const current = this.jobs.get(this.key(namespace, name));
    if (current) {
      current.phase = 'Failed';
    }
    this.jobs.delete(this.key(namespace, name));
  }

  setPhase(namespace: string, name: string, phase: ObservedJob['phase']): void {
    const current = this.jobs.get(this.key(namespace, name));
    if (current) {
      current.phase = phase;
    } else if (phase !== 'NotFound') {
      this.jobs.set(this.key(namespace, name), {
        name,
        namespace,
        phase,
        uid: `fake-${name}`,
      });
    }
  }

  createCountFor(name: string): number {
    return this.createCalls.filter((n) => n === name).length;
  }
}
