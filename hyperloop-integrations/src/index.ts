export {
  GitLabClient,
  InMemoryGitLabClient,
} from './gitlab/client.js';
export { GitLabRestClient } from './gitlab/gitlab-rest-client.js';
export { GitLabRestSddReader } from './gitlab/gitlab-rest-sdd-reader.js';
export type {
  CreateOrUpdateMrInput,
  MergeRequestRef,
  BranchRef,
  CommitRef,
  GitLabPort,
} from './gitlab/types.js';
export {
  InMemoryGitLabSDDReader,
  type GitLabSDDReader,
  type SddPackageSnapshot,
} from './gitlab/sdd-reader.js';

export {
  DevSpecChangeDetector,
  type DevSpecChangeDecision,
  type DevSpecChangeInput,
} from './gitlab/dev-spec-change-detector.js';
export { JenkinsCallbackParser } from './jenkins/callback.js';
export { verifySharedSecret } from './common/auth.js';
export {
  InMemoryEventBus,
  DEVSPEC_EVENTS_QUEUE,
  type EventBus,
  type NormalizedWorkflowEvent,
} from './events/event-bus.js';
export { SqsEventBus } from './events/sqs-event-bus.js';

export { buildEventGateway } from './event-gateway/app.js';
export type { EventGatewayOptions } from './event-gateway/app.js';
export {
  normalizeSddSubmitted,
  normalizeCiResult,
  normalizeMrMerged,
  buildWorkflowId,
} from './event-gateway/normalize.js';
