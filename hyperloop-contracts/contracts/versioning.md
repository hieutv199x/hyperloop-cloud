# Contract versioning

- Schema files use `$id` URIs under `https://hyperloop.dev/schemas/`.
- Event types are versioned in the name suffix (`.v1`).
- Envelope field `schemaVersion` is currently fixed to `1.0.0`.
- Breaking changes require a new schema file / event type version and compatibility tests.
- Non-breaking additive optional fields may land in the same major schema with updated examples.

## Compatibility rules

1. Consumers must ignore unknown optional fields.
2. Producers must not remove or rename required fields without a new major version.
3. Freeze v1 schemas before integrating Control Plane and Agent Runtime.
