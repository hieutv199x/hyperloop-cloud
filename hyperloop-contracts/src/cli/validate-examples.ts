import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const examples = [
  {
    schema: 'ci-result' as const,
    path: join(root, 'contracts/examples/ci-result.json'),
  },
];

let failed = false;
for (const example of examples) {
  const data = JSON.parse(readFileSync(example.path, 'utf8')) as unknown;
  const result = validate(example.schema, data);
  if (!result.valid) {
    failed = true;
    console.error(`Invalid example ${example.path}`, result.errors);
  } else {
    console.log(`OK ${example.path}`);
  }
}

if (failed) {
  process.exit(1);
}
