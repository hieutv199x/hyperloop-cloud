import type { KubernetesJobPort } from '../adapters/kubernetes/types.js';
import type { SchedulerConfig } from './config.js';
import type { ReadyTask, Reservation } from './types.js';

export class KubernetesJobDispatcher {
  constructor(
    private readonly kubernetes: KubernetesJobPort,
    private readonly config: SchedulerConfig,
  ) {}

  async dispatch(task: ReadyTask, reservation: Reservation): Promise<void> {
    await this.kubernetes.createJob({
      name: reservation.k8sJobName,
      namespace: this.config.kubernetes.namespace,
      image: this.config.kubernetes.image,
      labels: {
        'hyperloop.dev/task-id': task.taskId,
        'hyperloop.dev/workflow-id': task.workflowId,
        'hyperloop.dev/stage': task.stage,
        'hyperloop.dev/attempt': String(task.attempt),
      },
      env: {
        HYPERLOOP_TASK_ID: task.taskId,
        HYPERLOOP_WORKFLOW_ID: task.workflowId,
        HYPERLOOP_STAGE: task.stage,
        HYPERLOOP_ATTEMPT: String(task.attempt),
      },
      activeDeadlineSeconds: this.config.kubernetes.activeDeadlineSeconds,
      ttlSecondsAfterFinished: this.config.kubernetes.ttlSecondsAfterFinished,
    });
  }

  async ensureExists(task: ReadyTask, reservation: Reservation): Promise<'created' | 'exists'> {
    const observed = await this.kubernetes.getJob(
      this.config.kubernetes.namespace,
      reservation.k8sJobName,
    );
    if (observed.phase !== 'NotFound') {
      return 'exists';
    }
    await this.dispatch(task, reservation);
    return 'created';
  }
}
