import type { AgentStage, SchedulerConfig } from './config.js';
import type { ReadyTask } from './types.js';

export interface ScoredTask {
  task: ReadyTask;
  score: number;
}

export class PriorityPolicy {
  constructor(private readonly config: SchedulerConfig) {}

  basePriority(stage: AgentStage): number {
    return this.config.priorities[stage];
  }

  score(task: ReadyTask, now: Date = new Date()): number {
    let score = task.priority;
    if (this.config.fairness.agingEnabled) {
      const waitedMs = Math.max(0, now.getTime() - Date.parse(task.readyAt));
      const waitedSeconds = waitedMs / 1000;
      score += Math.floor(waitedSeconds / this.config.fairness.agingSecondsPerPoint);
    }
    return score;
  }

  rank(tasks: ReadyTask[], now: Date = new Date()): ScoredTask[] {
    return tasks
      .map((task) => ({ task, score: this.score(task, now) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.task.readyAt.localeCompare(b.task.readyAt);
      });
  }

  /**
   * Soft fairness: prefer stages under soft target when candidates exist,
   * otherwise allow borrowing unused slots from other classes.
   */
  selectCandidates(
    ranked: ScoredTask[],
    activeByStage: Record<AgentStage, number>,
    slotsAvailable: number,
  ): ReadyTask[] {
    if (slotsAvailable <= 0) return [];

    const selected: ReadyTask[] = [];
    const remaining = [...ranked];

    const underTarget = (stage: AgentStage) =>
      activeByStage[stage] < this.config.softTargets[stage];

    while (selected.length < slotsAvailable && remaining.length > 0) {
      const preferredIdx = remaining.findIndex((item) => underTarget(item.task.stage));
      const idx = preferredIdx >= 0 ? preferredIdx : 0;
      const [picked] = remaining.splice(idx, 1);
      if (!picked) break;

      const projectLimit = this.config.fairness.perProjectLimit;
      if (projectLimit != null && picked.task.project) {
        const projectCount =
          selected.filter((t) => t.project === picked.task.project).length +
          // approximate: caller may refine with active project counts
          0;
        if (projectCount >= projectLimit) {
          continue;
        }
      }

      selected.push(picked.task);
      activeByStage[picked.task.stage] += 1;
    }

    return selected;
  }
}
