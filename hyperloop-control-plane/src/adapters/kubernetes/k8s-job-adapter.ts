import * as k8s from '@kubernetes/client-node';
import type {
  DesiredJobSpec,
  KubernetesJobPort,
  ObservedJob,
} from './types.js';

function phaseFromJob(job: k8s.V1Job | undefined): ObservedJob['phase'] {
  if (!job) return 'NotFound';
  const status = job.status;
  if (!status) return 'Pending';
  if ((status.succeeded ?? 0) > 0) return 'Succeeded';
  if ((status.failed ?? 0) > 0) return 'Failed';
  if ((status.active ?? 0) > 0) return 'Running';
  return 'Pending';
}

/**
 * Production Kubernetes Job adapter.
 * createJob treats HTTP 409 as idempotent success (returns existing job).
 */
export class KubernetesJobAdapter implements KubernetesJobPort {
  private readonly batch: k8s.BatchV1Api;

  constructor(kubeConfig?: k8s.KubeConfig) {
    const kc = kubeConfig ?? new k8s.KubeConfig();
    if (!kubeConfig) {
      try {
        kc.loadFromCluster();
      } catch {
        kc.loadFromDefault();
      }
    }
    this.batch = kc.makeApiClient(k8s.BatchV1Api);
  }

  async createJob(spec: DesiredJobSpec): Promise<ObservedJob> {
    const body: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: spec.name,
        namespace: spec.namespace,
        labels: spec.labels,
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: spec.ttlSecondsAfterFinished,
        activeDeadlineSeconds: spec.activeDeadlineSeconds,
        template: {
          metadata: { labels: spec.labels },
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'agent',
                image: spec.image,
                env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
              },
            ],
          },
        },
      },
    };

    try {
      const created = await this.batch.createNamespacedJob({
        namespace: spec.namespace,
        body,
      });
      return {
        name: created.metadata?.name ?? spec.name,
        namespace: spec.namespace,
        phase: phaseFromJob(created),
        uid: created.metadata?.uid,
      };
    } catch (error: unknown) {
      const status = (error as { statusCode?: number; code?: number }).statusCode
        ?? (error as { code?: number }).code;
      if (status === 409) {
        return this.getJob(spec.namespace, spec.name);
      }
      throw error;
    }
  }

  async getJob(namespace: string, name: string): Promise<ObservedJob> {
    try {
      const job = await this.batch.readNamespacedJob({ name, namespace });
      return {
        name: job.metadata?.name ?? name,
        namespace,
        phase: phaseFromJob(job),
        uid: job.metadata?.uid,
      };
    } catch (error: unknown) {
      const status = (error as { statusCode?: number; code?: number }).statusCode
        ?? (error as { code?: number }).code;
      if (status === 404) {
        return { name, namespace, phase: 'NotFound' };
      }
      throw error;
    }
  }

  async deleteJob(namespace: string, name: string): Promise<void> {
    try {
      await this.batch.deleteNamespacedJob({
        name,
        namespace,
        propagationPolicy: 'Background',
      });
    } catch (error: unknown) {
      const status = (error as { statusCode?: number; code?: number }).statusCode
        ?? (error as { code?: number }).code;
      if (status === 404) return;
      throw error;
    }
  }
}
