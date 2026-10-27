import {
  AtomicSchedulerStore,
  ReservationConflictError,
} from './atomic-store.js';
import type { Reservation } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class JobReservationService {
  constructor(private readonly store: AtomicSchedulerStore) {}

  async reserveWithBackoff(
    taskId: string,
    maxAttempts = 5,
  ): Promise<Reservation | null> {
    let delay = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.store.reserve(taskId);
      } catch (error) {
        if (!(error instanceof ReservationConflictError)) {
          throw error;
        }
        if (error.message.includes('capacity exhausted')) {
          return null;
        }
        if (error.message.includes('not QUEUED') || error.message.includes('already exists')) {
          return null;
        }
        const jitter = Math.floor(Math.random() * delay);
        await sleep(delay + jitter);
        delay = Math.min(delay * 2, 100);
      }
    }
    return null;
  }

  async releaseOnce(
    taskId: string,
    terminalStatus: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED',
  ): Promise<'released' | 'already_released'> {
    return this.store.release(taskId, terminalStatus);
  }
}
