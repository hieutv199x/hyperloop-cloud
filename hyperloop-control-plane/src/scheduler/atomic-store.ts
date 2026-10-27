import { ConcurrencyManager } from '../capacity/concurrency-manager.js';
import type { AgentStage, SchedulerConfig } from './config.js';
import type { EnqueueTaskInput, ReadyTask, Reservation } from './types.js';
import { PriorityPolicy } from './priority-policy.js';

export class ReservationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReservationConflictError';
  }
}

export class AtomicSchedulerStore {
  private chain: Promise<unknown> = Promise.resolve();
  readonly capacity: ConcurrencyManager;
  readonly tasks = new Map<string, ReadyTask>();
  readonly reservations = new Map<string, Reservation>();
  readonly outbox: Array<{ type: string; payload: unknown; at: string }> = [];
  readonly decisionLog: Array<{ at: string; action: string; detail: string }> = [];
  /** Workflows that have approved an exact spec hash (HITL gate). */
  readonly approvedSpecHashes = new Map<string, string>();
  /** Completed task IDs for DAG dependency checks. */
  readonly completedTasks = new Set<string>();

  constructor(private readonly config: SchedulerConfig) {
    this.capacity = new ConcurrencyManager({
      limit: config.globalMaxConcurrentJobs,
      used: 0,
      version: 1,
    });
  }

  private reservationKey(taskId: string, attempt: number): string {
    return `${taskId}#${attempt}`;
  }

  private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  deterministicJobName(task: ReadyTask): string {
    const raw = `hl-${task.stage}-${task.taskId}-${task.attempt}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-');
    return raw.slice(0, 63);
  }

  async enqueue(input: EnqueueTaskInput, policy: PriorityPolicy): Promise<ReadyTask> {
    return this.withLock(() => {
      if (this.tasks.has(input.taskId)) {
        return structuredClone(this.tasks.get(input.taskId)!);
      }

      if (input.stage === 'coding') {
        const approved = this.approvedSpecHashes.get(input.workflowId);
        if (!input.approvedSpecHash || !approved || approved !== input.approvedSpecHash) {
          throw new Error(
            'Coding task requires exact approved spec hash (HITL) before queueing',
          );
        }
      }

      if (input.dependsOn?.length) {
        for (const dep of input.dependsOn) {
          if (!this.completedTasks.has(dep)) {
            throw new Error(`Dependency not satisfied: ${dep}`);
          }
        }
      }

      const dispatchable = input.dispatchable !== false;
      const task: ReadyTask = {
        taskId: input.taskId,
        workflowId: input.workflowId,
        stage: input.stage,
        repository: input.repository,
        project: input.project,
        priority: policy.basePriority(input.stage),
        readyAt: new Date().toISOString(),
        attempt: input.attempt ?? 1,
        status: dispatchable ? 'QUEUED' : 'QUEUED',
        version: 1,
        approvedSpecHash: input.approvedSpecHash,
        dependsOn: input.dependsOn,
      };

      // Non-dispatchable marker via missing ready eligibility handled by listQueued filter flag
      if (input.dispatchable === false) {
        (task as ReadyTask & { blocked?: boolean }).blocked = true;
      }

      this.tasks.set(task.taskId, task);
      this.outbox.push({
        type: 'agent.job_ready.v1',
        payload: { taskId: task.taskId, stage: task.stage },
        at: new Date().toISOString(),
      });
      return structuredClone(task);
    });
  }

  markSpecApproved(workflowId: string, specHash: string): void {
    this.approvedSpecHashes.set(workflowId, specHash);
  }

  clearSpecApproval(workflowId: string): void {
    this.approvedSpecHashes.delete(workflowId);
  }

  listQueued(): ReadyTask[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === 'QUEUED' && !(t as ReadyTask & { blocked?: boolean }).blocked)
      .map((t) => structuredClone(t));
  }

  countByStatus(status: ReadyTask['status']): number {
    return [...this.tasks.values()].filter((t) => t.status === status).length;
  }

  activeByStage(): Record<AgentStage, number> {
    const counts: Record<AgentStage, number> = { planner: 0, coding: 0, fix: 0 };
    for (const task of this.tasks.values()) {
      if (['RESERVED', 'SCHEDULED', 'RUNNING'].includes(task.status)) {
        counts[task.stage] += 1;
      }
    }
    return counts;
  }

  activeReservationCount(): number {
    return [...this.reservations.values()].filter((r) => r.state === 'ACTIVE').length;
  }

  getTask(taskId: string): ReadyTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  getReservation(taskId: string, attempt: number): Reservation | undefined {
    const reservation = this.reservations.get(this.reservationKey(taskId, attempt));
    return reservation ? structuredClone(reservation) : undefined;
  }

  /**
   * Reserve transaction analogue:
   * used < limit AND task QUEUED AND reservation attribute_not_exists
   */
  async reserve(taskId: string): Promise<Reservation> {
    return this.withLock(() => {
      const task = this.tasks.get(taskId);
      if (!task) {
        throw new ReservationConflictError(`Task not found: ${taskId}`);
      }
      if (task.status !== 'QUEUED') {
        throw new ReservationConflictError(`Task not QUEUED: ${taskId} (${task.status})`);
      }
      if ((task as ReadyTask & { blocked?: boolean }).blocked) {
        throw new ReservationConflictError(`Task blocked: ${taskId}`);
      }

      const key = this.reservationKey(task.taskId, task.attempt);
      if (this.reservations.has(key)) {
        throw new ReservationConflictError(`Reservation already exists: ${key}`);
      }

      if (!this.capacity.tryIncrement()) {
        throw new ReservationConflictError('Global capacity exhausted');
      }

      const k8sJobName = this.deterministicJobName(task);
      const now = new Date().toISOString();
      const reservation: Reservation = {
        taskId: task.taskId,
        attempt: task.attempt,
        state: 'ACTIVE',
        k8sJobName,
        createdAt: now,
        lastObservedAt: now,
      };

      task.status = 'RESERVED';
      task.k8sJobName = k8sJobName;
      task.version += 1;

      this.reservations.set(key, reservation);
      this.decisionLog.push({
        at: now,
        action: 'RESERVE',
        detail: `${taskId} -> ${k8sJobName}`,
      });
      return structuredClone(reservation);
    });
  }

  async markScheduled(taskId: string): Promise<void> {
    return this.withLock(() => {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'RESERVED') {
        throw new ReservationConflictError(`Cannot mark SCHEDULED: ${taskId}`);
      }
      task.status = 'SCHEDULED';
      task.version += 1;
    });
  }

  async markRunning(taskId: string): Promise<void> {
    return this.withLock(() => {
      const task = this.tasks.get(taskId);
      if (!task) return;
      if (task.status === 'SCHEDULED' || task.status === 'RESERVED') {
        task.status = 'RUNNING';
        task.version += 1;
      }
    });
  }

  /**
   * Release exactly once. Duplicate calls are no-ops.
   */
  async release(
    taskId: string,
    terminalStatus: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED',
  ): Promise<'released' | 'already_released'> {
    return this.withLock(() => {
      const task = this.tasks.get(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      const key = this.reservationKey(task.taskId, task.attempt);
      const reservation = this.reservations.get(key);
      if (!reservation) {
        throw new Error(`Reservation not found: ${key}`);
      }
      if (reservation.state !== 'ACTIVE') {
        return 'already_released';
      }

      reservation.state = 'RELEASED';
      reservation.releasedAt = new Date().toISOString();
      this.capacity.decrement();

      task.status = terminalStatus === 'CANCELLED' ? 'CANCELLED' : terminalStatus;
      task.version += 1;

      if (terminalStatus === 'SUCCEEDED') {
        this.completedTasks.add(task.taskId);
        task.status = 'FINALIZED';
      }

      this.outbox.push({
        type: 'agent.slot_released.v1',
        payload: { taskId, terminalStatus },
        at: new Date().toISOString(),
      });
      this.decisionLog.push({
        at: new Date().toISOString(),
        action: 'RELEASE',
        detail: `${taskId} ${terminalStatus}`,
      });
      return 'released';
    });
  }

  async cancelQueued(taskId: string): Promise<void> {
    return this.withLock(() => {
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.status !== 'QUEUED') {
        throw new ReservationConflictError(`Cannot cancelQueued in status ${task.status}`);
      }
      task.status = 'CANCELLED';
      task.version += 1;
    });
  }

  setCapacityLimit(limit: number): void {
    this.capacity.setLimit(limit);
  }

  listActiveReservationsMissingSchedule(): Array<{ task: ReadyTask; reservation: Reservation }> {
    const result: Array<{ task: ReadyTask; reservation: Reservation }> = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'RESERVED' || !task.k8sJobName) continue;
      const reservation = this.reservations.get(this.reservationKey(task.taskId, task.attempt));
      if (reservation?.state === 'ACTIVE') {
        result.push({
          task: structuredClone(task),
          reservation: structuredClone(reservation),
        });
      }
    }
    return result;
  }
}
