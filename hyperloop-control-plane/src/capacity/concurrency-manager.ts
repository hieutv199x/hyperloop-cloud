import type { AgentStage } from '../scheduler/config.js';
import type { CapacitySnapshot } from '../scheduler/types.js';

export interface CapacityState {
  limit: number;
  used: number;
  version: number;
}

export class ConcurrencyManager {
  constructor(private state: CapacityState) {}

  snapshot(byStage: Record<AgentStage, number>): CapacitySnapshot {
    return {
      limit: this.state.limit,
      used: this.state.used,
      available: Math.max(0, this.state.limit - this.state.used),
      version: this.state.version,
      byStage,
    };
  }

  getState(): CapacityState {
    return { ...this.state };
  }

  setLimit(limit: number): void {
    if (limit < 1) {
      throw new Error('Capacity limit must be >= 1');
    }
    this.state.limit = limit;
    this.state.version += 1;
  }

  /**
   * Atomic-style try increment. Caller must hold store lock.
   * Returns false if used >= limit (even if limit was lowered below used).
   */
  tryIncrement(): boolean {
    if (this.state.used >= this.state.limit) {
      return false;
    }
    this.state.used += 1;
    this.state.version += 1;
    return true;
  }

  /**
   * Decrement exactly once semantics enforced by caller via reservation state.
   */
  decrement(): void {
    if (this.state.used <= 0) {
      throw new Error('Capacity used cannot go below zero');
    }
    this.state.used -= 1;
    this.state.version += 1;
  }
}
