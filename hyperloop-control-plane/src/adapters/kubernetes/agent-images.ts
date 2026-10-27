export type AgentRole = 'planner' | 'coding' | 'fix';

export interface AgentImageSet {
  planner: string;
  coding: string;
  fix: string;
}

export const DEFAULT_AGENT_IMAGES: AgentImageSet = {
  planner: 'nexus.example/hyperloop/kiro-agent-planner:0.1.0',
  coding: 'nexus.example/hyperloop/kiro-agent-coding:0.1.0',
  fix: 'nexus.example/hyperloop/kiro-agent-fix:0.1.0',
};

/**
 * Resolves the allowlisted image for a Job role.
 * Control Plane only references digests/tags from config — never builds or runs Kiro.
 */
export function resolveAgentImage(
  role: AgentRole,
  images: AgentImageSet,
  allowlist?: ReadonlySet<string>,
): string {
  const image = images[role];
  if (!image) {
    throw new Error(`No image configured for agent role ${role}`);
  }
  if (allowlist && allowlist.size > 0 && !allowlist.has(image) && !allowlist.has('*')) {
    throw new Error(`Agent image not allowlisted for ${role}: ${image}`);
  }
  return image;
}
