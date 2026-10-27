import { z } from 'zod';
import {
  DEFAULT_AGENT_IMAGES,
  type AgentImageSet,
} from './adapters/kubernetes/agent-images.js';

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** memory (unit tests / local) | aws (DynamoDB/SQS/S3/K8s adapters). */
  ADAPTER_MODE: z.enum(['memory', 'aws']).default('memory'),
  AWS_REGION: z.string().default('ap-southeast-1'),
  AWS_ENDPOINT_URL: z.string().optional(),
  DYNAMODB_TABLE: z.string().default('hyperloop-workflows'),
  ARTIFACTS_BUCKET: z.string().default('hyperloop-artifacts'),
  GLOBAL_MAX_CONCURRENT_JOBS: z.coerce.number().default(100),
  AGENT_NAMESPACE: z.string().default('hyperloop-agents'),
  SQS_PLANNER_QUEUE_URL: z.string().optional(),
  SQS_CODING_QUEUE_URL: z.string().optional(),
  SQS_FIX_QUEUE_URL: z.string().optional(),
  SQS_DEVSPEC_EVENTS_QUEUE_URL: z.string().optional(),
  GITLAB_BASE_URL: z.string().optional(),
  GITLAB_TOKEN: z.string().optional(),
  GITLAB_SDD_WEBHOOK_SECRET: z.string().optional(),
  AGENT_IMAGE_PLANNER: z.string().default(DEFAULT_AGENT_IMAGES.planner),
  AGENT_IMAGE_CODING: z.string().default(DEFAULT_AGENT_IMAGES.coding),
  AGENT_IMAGE_FIX: z.string().default(DEFAULT_AGENT_IMAGES.fix),
  /** Comma-separated allowlist; empty or `*` allows configured defaults. */
  AGENT_IMAGE_ALLOWLIST: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  agentImages: AgentImageSet;
  agentImageAllowlist: ReadonlySet<string>;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const agentImages: AgentImageSet = {
    planner: parsed.AGENT_IMAGE_PLANNER,
    coding: parsed.AGENT_IMAGE_CODING,
    fix: parsed.AGENT_IMAGE_FIX,
  };
  const allowlistRaw = parsed.AGENT_IMAGE_ALLOWLIST?.trim();
  const agentImageAllowlist = new Set(
    allowlistRaw
      ? allowlistRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : ['*', ...Object.values(agentImages)],
  );
  return { ...parsed, agentImages, agentImageAllowlist };
}
