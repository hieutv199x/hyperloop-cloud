import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
} from '@aws-sdk/client-dynamodb';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:18000';
const region = process.env.AWS_REGION ?? 'ap-southeast-1';
const tableName = process.env.DYNAMODB_TABLE ?? 'hyperloop-workflows-dev';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const def = JSON.parse(
  readFileSync(
    join(root, 'hyperloop-control-plane/migrations/hyperloop-workflows.table.json'),
    'utf8',
  ),
);
def.TableName = tableName;

const client = new DynamoDBClient({
  region,
  endpoint,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

const listed = await client.send(new ListTablesCommand({}));
if (listed.TableNames?.includes(tableName)) {
  await client.send(new DescribeTableCommand({ TableName: tableName }));
  console.log(`table exists: ${tableName}`);
  process.exit(0);
}

await client.send(new CreateTableCommand(def));
console.log(`created table: ${tableName}`);
