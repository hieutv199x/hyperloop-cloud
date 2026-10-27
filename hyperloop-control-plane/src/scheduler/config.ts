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
    /** @deprecated Prefer images.planner|coding|fix (v1.3 role images). */
    image?: string;
    images: {
      planner: string;
      coding: string;
      fix: string;
    };
    imageAllowlist?: string[];
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
    images: {
      planner: 'nexus.example/hyperloop/kiro-agent-planner:0.1.0',
      coding: 'nexus.example/hyperloop/kiro-agent-coding:0.1.0',
      fix: 'nexus.example/hyperloop/kiro-agent-fix:0.1.0',
    },
    imageAllowlist: ['*'],
    backoffLimit: 0,
    ttlSecondsAfterFinished: 600,
    activeDeadlineSeconds: 3600,
  },
};
