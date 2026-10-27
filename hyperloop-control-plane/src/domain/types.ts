import type { WorkflowState } from './workflow-states.js';

export interface DevSpecTarget {
  repository: string;
  workingBranch: string;
  targetBranch: string;
}

export interface DevSpecDocument {
  apiVersion: string;
  kind: string;
  metadata: {
    project: string;
    userStory: string;
    revision: number;
  };
  spec: {
    status: string;
    requirements: string[];
    analysis?: string[];
    designs: string[];
    acceptanceCriteria: string[];
    targets: DevSpecTarget[];
    execution: {
      requireSpecApproval: boolean;
      maxAutoFixAttempts: number;
    };
  };
}

export interface DesiredJobIntent {
  jobId: string;
  stage: 'planner' | 'coding' | 'fix';
  status: 'JOB_DESIRED' | 'SCHEDULED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  repository?: string;
  createdAt: string;
  k8sJobName: string;
}

export interface ApprovalRecord {
  decisionId: string;
  decision: 'APPROVED' | 'SPEC_CHANGES_REQUESTED' | 'REJECTED';
  approvedSpecHash: string;
  approvedSddCommitSha: string;
  approverEntraId: string;
  approverDisplayName: string;
  expectedVersion: number;
  comment?: string;
  decidedAt: string;
  invalidatedAt?: string;
}

export interface PlanServiceNode {
  repository: string;
  workingBranch: string;
  targetBranch: string;
  dependsOn: string[];
}

export type ServiceExecutionState =
  | 'PENDING'
  | 'CODING'
  | 'AWAITING_CI'
  | 'FIXING'
  | 'READY'
  | 'FAILED'
  | 'NEEDS_HUMAN';

export interface ServiceExecution {
  repository: string;
  workingBranch: string;
  targetBranch: string;
  dependsOn: string[];
  state: ServiceExecutionState;
  expectedCommitSha?: string;
  mrIid?: number;
  fixAttempts: number;
}

export interface WorkflowRecord {
  workflowId: string;
  project: string;
  userStory: string;
  revision: number;
  status: WorkflowState;
  version: number;
  sddProject?: string;
  sddCommitSha: string;
  sddPath: string;
  clarificationIssues?: Array<{ code: string; message: string; path?: string }>;
  owner?: string;
  targets: DevSpecTarget[];
  planServices?: PlanServiceNode[];
  services: Record<string, ServiceExecution>;
  specHash?: string;
  implementationSpecUri?: string;
  approvals: ApprovalRecord[];
  desiredJobs: DesiredJobIntent[];
  /** v1.3: issued execution leases / fence tokens (durable with workflow). */
  executions?: ExecutionLease[];
  createdAt: string;
  updatedAt: string;
  timeline: Array<{ at: string; type: string; detail?: string }>;
}

export interface ExecutionLease {
  executionId: string;
  jobId: string;
  role: 'planner' | 'coding' | 'fix';
  fenceToken: string;
  leaseExpiresAt: string;
  issuedAt: string;
  repository?: string;
  /** When set, authorize-push must deny further git mutation. */
  fencedAt?: string;
}

export interface ApproveSpecInput {
  workflowId: string;
  approvedSpecHash: string;
  /** v1.2: HITL also binds the pinned SDD commit SHA. */
  approvedSddCommitSha: string;
  decision: 'APPROVED' | 'SPEC_CHANGES_REQUESTED' | 'REJECTED';
  expectedVersion: number;
  approver: {
    entraId: string;
    displayName: string;
    email?: string;
  };
  comment?: string;
}

export interface SubmitDevSpecInput {
  eventId: string;
  occurredAt: string;
  project: string;
  userStory: string;
  revision: number;
  sddCommitSha: string;
  sddPath: string;
  devSpec: DevSpecDocument;
  webhookSecret?: string;
  /** v1.2: when set, persist workflow as NEEDS_SPEC_CLARIFICATION and do not schedule Planner. */
  clarificationIssues?: Array<{ code: string; message: string; path?: string }>;
  /** Optional SDD project id for revision lineage (defaults to project). */
  sddProject?: string;
}

export type SubmitDevSpecResult =
  | { outcome: 'created'; workflow: WorkflowRecord }
  | { outcome: 'duplicate'; workflow: WorkflowRecord }
  | { outcome: 'rejected'; reason: string; statusCode: number };
