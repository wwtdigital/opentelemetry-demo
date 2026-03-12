# Fix Production Bug

## Outcome

Find the exact root cause of a production bug and open a PR with a minimal fix.

## Procedure

1. Read ALL documentation in the repository (READMEs, contributing guides, docs/ folder, bug tables, known-issues lists) before writing any code. There may be gotchas, conventions, or prior bug records that affect your approach.
2. Search for error-producing code paths: error returns, exception throws, failed queries, bad status codes, incorrect logic.
3. Identify which function is most likely responsible for the described failure.
4. Trace from that function into any helpers it calls (query builders, data transformers, RPC wrappers, etc.).
5. Build a chain of evidence: described symptom → responsible function → helper → exact failing line.
6. Only after proving the chain of evidence, implement the smallest possible fix.
7. Verify the fix compiles and passes available tests.
8. Update or create a bug table (e.g. `docs/bugs.md` or `bugs/known-issues.md` — use whatever exists, or create one if none does) with an entry for this bug: root cause, affected file/line, fix applied, and date.
9. Open a PR that includes:
    - The exact root cause tied to specific file and line numbers
    - The chain of evidence from symptom → function → failing line
    - What the fix changes and why
    - Any hypotheses that were considered and rejected

## Specifications

- The fix must be minimal — ideally a single-line change.
- The code must compile/build successfully after the fix.
- The PR description must reference the exact file path and line number of the root cause.

## Advice and Pointers

- Bug descriptions are often sparse. Do not expect to be told which function or line is broken. You must find it by reading the code.
- Prioritize error-return paths (e.g. gRPC status codes, HTTP 5xx, exception handlers) before investigating type conversions or refactors.
- SQL/query bugs (wrong column names, missing joins, typos in field names) are common. Cross-reference query strings against the actual schema.
- If a function wraps an error, trace upstream to find the original error source rather than only looking at the wrapper.

## Forbidden Actions

- Do NOT modify infrastructure files (docker-compose, Dockerfiles, CI configs) unless explicitly told to.
- Do NOT modify environment variable files.
- Do NOT modify files outside the identified area unless you have proven evidence the bug originates elsewhere.
- Do NOT invent hypotheses about "production-only drift", "hidden stack traces", or "runtime-only configuration differences" unless you can prove them from the source code.
- Do NOT perform speculative refactors, type system changes, or architectural changes.
- Do NOT add new dependencies.
- Do NOT delete or weaken existing tests.
