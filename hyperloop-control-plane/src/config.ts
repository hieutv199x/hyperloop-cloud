import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AWS_REGION: z.string().default('ap-southeast-1'),
  DYNAMODB_TABLE: z.string().default('hyperloop-workflows'),
  ARTIFACTS_BUCKET: z.string().default('hyperloop-artifacts'),
  GLOBAL_MAX_CONCURRENT_JOBS: z.coerce.number().default(100),
  AGENT_NAMESPACE: z.string().default('hyperloop-agents'),
  GITLAB_SDD_WEBHOOK_SECRET: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
