import type {
  EventBus,
  NormalizedWorkflowEvent,
} from '@hyperloop/integrations';
import { DEVSPEC_EVENTS_QUEUE } from '@hyperloop/integrations';
import type { DevSpecDocument } from '../domain/types.js';
import type { WorkflowOrchestrator } from '../application/workflow-orchestrator.js';

export interface EventConsumerDeps {
  eventBus: EventBus;
  orchestrator: WorkflowOrchestrator;
  queueName?: string;
}

/**
 * Consumes normalized Event Gateway messages (SQS analogue).
 * Does not expose webhook routes — those live in Event Gateway (v1.3).
 */
export class EventConsumer {
  constructor(private readonly deps: EventConsumerDeps) {}

  async pollOnce(max = 10): Promise<number> {
    const queue = this.deps.queueName ?? DEVSPEC_EVENTS_QUEUE;
    const batch = await this.deps.eventBus.receive(queue, max);
    for (const event of batch) {
      await this.handle(event);
    }
    return batch.length;
  }

  async handle(event: NormalizedWorkflowEvent): Promise<void> {
    switch (event.eventType) {
      case 'SDD_REVISION_SUBMITTED':
        await this.handleSddSubmitted(event);
        return;
      case 'CI_RESULT_RECEIVED':
        // M5: CiDecisionService
        return;
      case 'MR_MERGED':
        // M5: merge aggregation
        return;
      default:
        return;
    }
  }

  private async handleSddSubmitted(event: NormalizedWorkflowEvent): Promise<void> {
    const payload = event.payload as {
      project: string;
      sddProject?: string;
      userStory: string;
      revision: number;
      sddCommitSha: string;
      sddPath: string;
      devSpec: DevSpecDocument;
    };

    await this.deps.orchestrator.submitDevSpec({
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      project: payload.project,
      sddProject: payload.sddProject,
      userStory: payload.userStory,
      revision: payload.revision,
      sddCommitSha: payload.sddCommitSha,
      sddPath: payload.sddPath,
      devSpec: payload.devSpec,
    });
  }
}
