---
description: Examine a service in the OTel demo codebase, design a realistic bug, and inject it so Devin AI can find and fix it via the self-healing loop.
---

# Inject Bug into OTel Demo Service

This workflow examines a service's source code, designs a realistic production bug
that will be visible in APM (errors, exceptions, latency), and injects it into the
code. The bug must be fixable by an AI agent (Devin) without any knowledge of feature
flags or intentional injection.

## Prerequisites
- The target service name (e.g., `product-catalog`, `payment`, `cart`, `recommendation`)
- The repo is the upstream `open-telemetry/opentelemetry-demo` fork

## Step 1 — Identify the target service

Ask the user which service to inject a bug into. If they don't specify, pick one from
this priority list (best demo candidates first):

| Service | Directory | Language | Why it's a good target |
|---|---|---|---|
| product-catalog | src/product-catalog/ | Go | Core service, called on every page load |
| payment | src/payment/ | Node.js | Checkout-critical, easy to understand |
| cart | src/cart/src/ | C# (.NET) | Stateful service with Redis backing |
| recommendation | src/recommendation/ | Python | Simpler code, good for Python demos |
| currency | src/currency/ | C++ | Interesting for polyglot demos |
| checkout | src/checkout/ | Go | Orchestrator, calls many downstream services |

## Step 2 — Read and analyze the service code

Read ALL source files in the target service directory. Understand:

1. **Entry points** — gRPC handlers, HTTP endpoints, main request paths
2. **Data flow** — How requests move through the service (DB queries, cache access, downstream calls)
3. **Error handling** — Where errors are caught, logged, and propagated
4. **Existing feature-flag code** — Identify it so you know what to AVOID. The bug must NOT involve feature flags in any way.
5. **OTel instrumentation** — Spans, attributes, metrics already in place (the bug should produce telemetry that APM tools can detect)

## Step 3 — Design the bug

Choose ONE bug type from the catalog below. The bug must satisfy ALL of these criteria:

### Bug Design Criteria
- **Realistic** — Looks like a mistake a developer could actually make (typo, off-by-one, wrong operator, missing null check, incorrect string format)
- **APM-visible** — Causes errors, exceptions, or latency spikes that show up in traces/metrics
- **NOT flag-related** — Must not touch `demo.flagd.json`, OpenFeature SDK calls, or any flag-checking code
- **Deterministic or high-frequency** — Should trigger on most/all requests to that code path (not a rare race condition)
- **Fixable in 1-5 lines** — An AI agent should be able to find the root cause and fix it with a small, targeted change
- **Single-file change** — The bug should be contained to one source file

### Bug Catalog (pick the best fit for the target service)

**Category A: Logic Errors**
- Wrong comparison operator (`>` instead of `>=`, `==` instead of `!=`)
- Off-by-one in array/slice indexing
- Swapped function arguments
- Wrong variable used in a calculation (e.g., using `nanos` where `units` was intended)
- Incorrect string format specifier causing parse failure

**Category B: Error Handling Failures**
- Removed or broken null/nil/undefined check that causes a crash on specific inputs
- Catch block that swallows errors silently, causing downstream failures
- Error message that exposes wrong status code (returning 500 instead of 404, or vice versa)

**Category C: Data Processing Bugs**
- SQL query with wrong column name or missing WHERE clause
- Incorrect protobuf field mapping
- Wrong type conversion (int to float truncation, string encoding issue)
- Broken serialization/deserialization

**Category D: Performance Bugs**
- Accidentally added `time.Sleep` / `Thread.Sleep` / `setTimeout` in a hot path
- N+1 query pattern (loop that makes a DB call per item)
- Missing pagination causing full table scan

## Step 4 — Implement the bug

Make the MINIMAL edit to inject the bug. Follow these rules:

1. **Change only the service code** — Never touch `demo.flagd.json`, `docker-compose.yml`, `.env`, or any config files
2. **Do NOT add comments** explaining the bug — it must look like a real mistake
3. **Do NOT remove existing OTel instrumentation** — The traces/spans must still be generated so APM detects the error
4. **Keep the service startable** — The bug should cause runtime errors on requests, not prevent the service from booting
5. **Preserve imports and structure** — Don't reorganize the file; make the smallest diff possible

## Step 5 — Document the bug (internal only)

Create or update the file `bugs/injected-bugs.md` with an entry for this bug.
This file is for the HUMAN operator only — it is NOT shared with Devin.

Each entry should include:
```markdown
### Bug #{number}: {service-name} — {short title}
- **File:** `src/{service}/{filename}`
- **Type:** {category from Step 3}
- **What was changed:** {one-line description of the edit}
- **Expected symptom:** {what APM will show — error rate spike, specific exception, latency}
- **How to verify:** {curl command or browser action that triggers it}
- **Correct fix:** {what the 1-5 line fix should look like}
- **Injected on:** {date}
```

## Step 6 — Update bridge prompt and context (first time only)

If this is the first bug injection, update:

1. **`bridge/bridge.py`** — Remove any references to feature flags from the Devin prompt template. The prompt should say the error is a real production bug, not mention flags at all.
2. **`docs/DEVIN_CONTEXT.md`** — Remove or downplay the feature flag section. Devin should look at the service code for real bugs, not toggle flags.

## Step 7 — Verify

If Docker is running, rebuild the affected service:
```
docker compose build {service-name}
docker compose up {service-name} -d
```

Then hit the service's code path (via the storefront or a direct gRPC/curl call) and
confirm the error appears in logs or traces.

---

## Example: Injecting a bug into product-catalog (Go)

**Bug:** Change the SQL query in `getProductFromDB` to use `p.id = $2` instead of `p.id = $1`, causing all single-product lookups to fail with a parameter mismatch error.

**Edit in `src/product-catalog/main.go`:**
```go
// Before (correct)
WHERE p.id = $1

// After (bug)
WHERE p.id = $2
```

**Symptom:** Every `GetProduct` call returns a Postgres error → gRPC Internal error → frontend shows product not found → APM shows error rate spike on `product-catalog` service.

**Fix:** Change `$2` back to `$1`.

---

## Example: Injecting a bug into payment (Node.js)

**Bug:** In `charge.js`, change the expiry check from `>` to `<`, causing ALL non-expired cards to be rejected.

**Edit in `src/payment/charge.js`:**
```javascript
// Before (correct)
if ((currentYear * 12 + currentMonth) > (year * 12 + month)) {

// After (bug)
if ((currentYear * 12 + currentMonth) < (year * 12 + month)) {
```

**Symptom:** Every checkout attempt fails with "credit card expired" → gRPC error → APM shows error spike on `payment` service during checkout flow.

**Fix:** Change `<` back to `>`.

---

## Notes

- You can inject multiple bugs across different services for a richer demo
- Run this workflow once per service you want to demonstrate
- To "heal" without Devin, just `git checkout -- src/{service}/` to revert
- The bugs/ directory should be added to .gitignore so it doesn't leak to Devin
