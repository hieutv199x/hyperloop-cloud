import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { ErrorCodes } from './error-codes.js';

const addFormats =
  (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ??
  addFormatsModule;

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemasDir = join(__dirname, '..', 'contracts', 'schemas');

export type SchemaName =
  | 'sdd-manifest'
  | 'dev-spec'
  | 'implementation-spec'
  | 'workflow-event'
  | 'agent-job-request'
  | 'agent-result'
  | 'ci-result'
  | 'approval-decision'
  | 'job-queue-request'
  | 'job-reservation'
  | 'concurrency-policy'
  | 'scheduler-event';

const schemaFiles: Record<SchemaName, string> = {
  'sdd-manifest': 'sdd-manifest.schema.json',
  'dev-spec': 'dev-spec.schema.json',
  'implementation-spec': 'implementation-spec.schema.json',
  'workflow-event': 'workflow-event.schema.json',
  'agent-job-request': 'agent-job-request.schema.json',
  'agent-result': 'agent-result.schema.json',
  'ci-result': 'ci-result.schema.json',
  'approval-decision': 'approval-decision.schema.json',
  'job-queue-request': 'job-queue-request.schema.json',
  'job-reservation': 'job-reservation.schema.json',
  'concurrency-policy': 'concurrency-policy.schema.json',
  'scheduler-event': 'scheduler-event.schema.json',
};

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
  errorCode?: string;
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
});
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);

const validators = new Map<SchemaName, ValidateFunction>();

function loadValidator(name: SchemaName): ValidateFunction {
  const cached = validators.get(name);
  if (cached) {
    return cached;
  }

  const file = schemaFiles[name];
  if (!file) {
    throw new Error(`${ErrorCodes.UNKNOWN_SCHEMA}: ${name}`);
  }

  const schema = JSON.parse(readFileSync(join(schemasDir, file), 'utf8')) as object;
  const validate = ajv.compile(schema);
  validators.set(name, validate);
  return validate;
}

export function validate(name: SchemaName, data: unknown): ValidationResult {
  const validateFn = loadValidator(name);
  const valid = validateFn(data) === true;
  const errors = validateFn.errors ?? [];

  let errorCode: string | undefined;
  if (!valid) {
    const branchError = errors.some((e) => e.instancePath.includes('targetBranch'));
    const hashError = errors.some((e) => e.instancePath.toLowerCase().includes('spechash'));
    if (branchError) {
      errorCode = ErrorCodes.INVALID_BRANCH;
    } else if (hashError) {
      errorCode = ErrorCodes.INVALID_SPEC_HASH;
    } else if (name === 'workflow-event') {
      errorCode = ErrorCodes.INVALID_EVENT_ENVELOPE;
    } else {
      errorCode = ErrorCodes.INVALID_SCHEMA;
    }
  }

  return { valid, errors, errorCode };
}

export function listSchemas(): SchemaName[] {
  return Object.keys(schemaFiles) as SchemaName[];
}
