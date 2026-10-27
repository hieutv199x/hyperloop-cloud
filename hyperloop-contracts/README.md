# hyperloop-contracts

JSON Schema contracts, OpenAPI/AsyncAPI, validators, and fixtures for Hyperloop Cloud.

## Setup

```bash
npm install
npm test
npm run build
```

## Layout

- `contracts/schemas` — v1 schemas (freeze before service integration)
- `contracts/examples` — valid examples
- `contracts/openapi` / `contracts/asyncapi`
- `src` — Ajv validators, states, error codes

## Acceptance (M0)

- [x] Scaffold schemas + validator package
- [x] Full fixture matrix for every schema (valid + key invalid cases)
- [ ] Compatibility tests across schema revisions (later when schemas evolve)
