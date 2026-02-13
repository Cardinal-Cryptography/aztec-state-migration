# /review-pr
Review local changes like a pull request, without GitHub.

## Usage
- `/review-pr` (defaults to `main..HEAD`)
- `/review-pr <base>..<head>` (example: `/review-pr origin/main..HEAD`)

## What to do
1) Show scope:
   - `git status`
   - `git diff --stat <range>`
2) Review diff for:
   - migration correctness (double-claim prevention, replay prevention)
   - L1↔L2 message verification and archive root checks
   - note hash / nullifier construction and domain separation (domain separation = adding a fixed tag to a hash so it cannot be reused in another context)
   - unsafe defaults / fail-open behavior
3) Output:
   - short risk summary
   - findings with file paths + exact locations
   - suggested fixes
4) Tests:
   - default to compile/unit tests first
   - do not run `yarn test:setup` / `yarn test:mode-a` / `yarn test:mode-b` unless a change clearly affects E2E behavior
