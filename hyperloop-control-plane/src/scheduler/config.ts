export type AgentStage = 'planner' | 'coding' | 'fix';

export interface SchedulerConfig {
  globalMaxConcurrentJobs: number;
  pollIntervalSeconds: number;
  reconciliationIntervalSeconds: number;
  priorities: Record<AgentStage, number>;
  softTargets: Record<AgentStage, number>;
  fairness: {
    agingEnabled: boolean;
    agingSecondsPerPoint: number;
    perProjectLimit: number | null;
  };
  queues: Record<AgentStage, string>;
  kubernetes: {
    namespace: string;
    image: string;
    backoffLimit: number;
    ttlSecondsAfterFinished: number;
    activeDeadlineSeconds: number;
  };
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  globalMaxConcurrentJobs: 100,
  pollIntervalSeconds: 5,
  reconciliationIntervalSeconds: 30,
  priorities: {
    fix: 100,
    coding: 50,
    planner: 10,
  },
  softTargets: {
    fix: 20,
    coding: 65,
    planner: 15,
  },
  fairness: {
    agingEnabled: true,
    agingSecondsPerPoint: 30,
    perProjectLimit: null,
  },
  queues: {
    planner: 'hyperloop-planner-queue',
    coding: 'hyperloop-coding-queue',
    fix: 'hyperloop-fix-queue',
  },
  kubernetes: {
    namespace: 'hyperloop-agents',
    image: 'nexus.example/hyperloop/kiro-agent:0.1.0',
    backoffLimit: 0,
    ttlSecondsAfterFinished: 600,
    activeDeadlineSeconds: 3600,
  },
};
