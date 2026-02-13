# CLAUDE.md — Dual-Rollup Migration (Aztec + Noir)

## 0) Definitions (read once)
- Noir: A programming language for zero-knowledge proofs (proofs that show something is true without revealing secret data).
- Aztec: A zkRollup (a Layer 2 network that uses zero-knowledge proofs).
- L1 (Layer 1): The base chain (usually Ethereum).
- L2 (Layer 2): A chain that settles to L1.
- MCP (Model Context Protocol): A local tool interface Claude can use to search and read code/doc repos.
- TDD (test-driven development): Write a failing test first, then write the smallest code to pass it.

---

# SECTION A — PROJECT-SPECIFIC RULES (do not skip)

## A1) Tech stack and versions (source of truth)
- Noir: `v1.0.0-beta.x`
- Aztec Network: `v3.0.0-devnet.6-patch.1`
- Build tool: Nargo (Noir CLI + package tool)
- TypeScript tooling: Yarn scripts (see A3)
- Solidity: Present in this repo (exact compiler/version must be taken from repo config, not guessed)

**Rules**
1) Never guess versions. Read them from:
   - `package.json` / lockfile
   - `Nargo.toml`
   - any Solidity config present (`foundry.toml`, `hardhat.config.*`, `remappings.txt`, etc.)
2) When Aztec APIs are involved, prefer local code in `node_modules/@aztec/` over online docs.

## A2) Project docs and architecture (source of truth)
### Purpose
This repo implements a **dual-rollup migration** using cryptographic proofs anchored by L1.

### Spec and architecture files (standard layout)
We keep docs in `docs/` using a layout that can be reused across projects.

**Spec (migration design including Mode A / Mode B)**
- `docs/spec/migration-spec.md`  ← high level specification

**Architecture**
- `docs/arch/overview.md`        ← dual-rollup architecture summary
- `docs/arch/flows.md`           ← step-by-step flows (Mode A / Mode B)
- `docs/arch/threat-model.md`    ← trust assumptions + threat model

**Operational docs**
- `docs/ops/testing.md`          ← how to run tests locally and in CI
- `docs/ops/deploy.md`           ← if deploy exists in this repo
- `docs/ops/troubleshooting.md`  ← common local network issues

**Rules**
1) Any time you need "how Aztec works" or "standard library details," check the local `node_modules/@aztec/` implementation first.
2) Treat `node_modules/@aztec/` as **read-only** unless the task explicitly asks to change it.
3) If you rename or move doc files, update references in `README.md` and any internal links.

## A3) Local development commands (use these exact commands unless repo scripts change)

### Compilation
- Noir compile: `yarn noir:compile`
- TypeScript bindings/codegen: `yarn noir:codegen`
- Solidity compile: `yarn sol:compile`
- Clean: `yarn clean`

### Testing

### Recommended verification defaults
- Full E2E (only when needed): `yarn check:full`

Use `yarn check:full` when changes affect:
- migration flow logic across old/new rollup
- archive root verification
- L1↔L2 message consumption
- note hashing / nullifier behavior that the E2E test exercises

- Unit tests (Noir): `nargo test --show-output`

### E2E migration test (complex flow)
1) Setup (starts dual rollup sandboxes):
   - `yarn test:setup`  
   - OLD sandbox: `http://localhost:8080`
   - NEW sandbox: `http://localhost:8081`
2) Run migration test:
   - `yarn test:migration`
3) Stop and clean up:
   - `yarn test:stop`

**Rules**
1) When you change migration logic, run the E2E test flow unless it is impossible (then explain exactly why).
2) If you change ports, endpoints, or scripts, update:
   - `README.md`
   - `docs/ops/testing.md`

## A4) “No guessing” rule for Aztec standard library and helpers
- If the task references “standard library,” “aztec-nr,” or a helper function:
  1) Use Aztec plugin MCP search to locate the real implementation in `node_modules/@aztec/`.
  2) Quote file paths and function names from the local repo.
  3) Only use online docs if local code does not answer the question.

---

# SECTION B — GENERAL OPERATING RULES (edit only if workflow changes)

## B1) Installed plugins and routing

### 1) Superpowers (obra/superpowers) — use for HOW we work
Use it for workflow discipline:
- Brainstorm (only if requirements are unclear)
- Plan
- TDD implementation (tests first where practical)
- Verify (run commands)
- Review (read diff for correctness and style)

### 2) Aztec plugin (critesjosh/aztec-claude-plugin) — use for WHAT we do
Use it for:
- Noir `.nr` work and `Nargo.toml`
- Aztec.nr contract structure, storage layout, notes, nullifiers
- aztec.js integration and TypeScript client usage
- Searching `node_modules/@aztec/` for the exact devnet version behavior

**Hard rule**
Prefer Aztec plugin commands + MCP search over guessing syntax or APIs.


## B2) Session start rule (version alignment)
At the start of a session where Aztec/Noir changes are expected:
- Run `/aztec-version` and align it to the versions in Section A.

If there is any mismatch, stop and resolve it before making code changes.

## B3) Aztec plugin shortcuts (use when relevant)
- New contract: `/aztec:new-contract <Name>`
- Add function: `/aztec:add-function <desc>`
- Add test: `/aztec:add-test <desc>`
- Review: `/aztec:review-contract <path>`
- Deploy: `/aztec:deploy <Contract>`
- Generate client: `/aztec:generate-client <Contract>`

## B4) Local security skills (project-scoped)
These are available as slash commands:

- /audit-context-building: Build system context (assets, trust assumptions, flows).
- /entry-point-analyzer: Enumerate external entry points in Noir/Solidity/TS and what state they can change.
- /spec-to-code-compliance: Map docs/spec statements to code + tests, list gaps.
- /insecure-defaults: Identify unsafe defaults and missing checks (especially around migration and replay protection).
- /sharp-edges: Identify confusing or error-prone interfaces and propose safer patterns.

These skills are read-only by design and should not run long tests automatically.


## B5) Documentation mandate (strict consistency check)
**Update docs when code changes affect documented behavior.**

### Required docs updates (when applicable)
- Setup/start changed → update `README.md` and `docs/ops/testing.md`
- Contract interface changed (public functions, events, externally visible behavior) → update `docs/arch/flows.md` and/or a contract reference doc
- Test approach changed → update `docs/ops/testing.md`
- Security/trust assumptions changed → update `docs/arch/threat-model.md`

### Doc style rules
- Prefer short sections, lists, and exact commands.
- Keep docs in the same repo (no external docs).
- When describing behavior, link to the spec/flow doc where possible.

## B6) Solidity guidelines (only when `.sol` is edited)
- Keep changes minimal and easy to review.
- Never change an external interface (public/external function signatures, events) without updating docs.
- Add or update tests that cover the Solidity behavior change.
- Document Solidity-facing interfaces in `docs/solidity/overview.md` (create if missing).

## B7) End-of-turn checklist (must be satisfied before you stop)
1) Tests
   - Run the relevant commands from Section A.
   - State results and any failures.
2) Docs
   - List any doc files updated.
3) Diff sanity
   - Confirm changes match the plan/spec.
4) If anything was not verified
   - State exactly what was skipped and why, and what command should be run next.


## Bx) Local workflow commands (no GitHub)
- `/review-pr [range]`: Review local diff like a pull request (defaults to `main..HEAD`).
- `/fix-issue <text-or-path>`: Apply a fix from local text, with fast checks by default.

Additional local security skills:
- `/differential-review`
- `/variant-analysis`
- `/static-analysis`
- `/property-based-testing`
