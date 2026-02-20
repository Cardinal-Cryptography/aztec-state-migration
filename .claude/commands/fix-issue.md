# /fix-issue
Fix an issue described in local text (no GitHub).

## Usage
- `/fix-issue <path-to-issue.md>`
- `/fix-issue <pasted issue text>`

## What to do
1) Parse the issue:
   - expected behavior
   - actual behavior
   - acceptance checks
2) Identify likely areas:
   - noir/contracts/migrator/**
   - noir/contracts/example_app/**
   - solidity/**
   - e2e-tests/migration-mode-a.test.ts
   - e2e-tests/migration-mode-b.test.ts
   - docs/spec/migration-spec.md
3) Implement smallest safe fix.
4) Verify (fast by default):
   - `yarn noir:compile`
   - `yarn sol:compile`
   - `nargo test --show-output` (if relevant)
   - `yarn build` (TypeScript compile)
   - `yarn test:hash` if hashing or serialization could be affected
5) Run E2E only when needed:
   - `yarn test:setup`
   - `yarn test:mode-a` and/or `yarn test:mode-b`
   - `yarn test:stop`

