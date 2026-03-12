"""
Self-Healing Bridge Service

Receives webhooks from APM tools (Splunk, Grafana, Honeycomb, New Relic),
deduplicates alerts, and dispatches Devin AI sessions to fix detected errors.
"""

import hashlib
import json
import logging
import os
import time
from datetime import datetime, timezone

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEVIN_API_KEY = os.environ.get("DEVIN_API_KEY", "")       # Service user key (starts with cog_)
DEVIN_ORG_ID = os.environ.get("DEVIN_ORG_ID", "")         # Devin organization ID
DEVIN_PLAYBOOK_ID = os.environ.get("DEVIN_PLAYBOOK_ID", "")  # Optional playbook ID
REPO_URL = os.environ.get("REPO_URL", "")
DEDUP_WINDOW_SECONDS = int(os.environ.get("DEDUP_WINDOW_SECONDS", "3600"))
SPLUNK_WEBHOOK_SECRET = os.environ.get("SPLUNK_WEBHOOK_SECRET", "")
SPLUNK_API_TOKEN = os.environ.get("SPLUNK_API_TOKEN", "")
SPLUNK_REALM = os.environ.get("SPLUNK_REALM", "us1")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

SERVICE_METADATA: dict[str, dict] = {
    "product-catalog": {
        "directory": "src/product-catalog",
        "language": "Go",
        "commands": [
            "cd src/product-catalog",
            r'rg -n "ListProducts|GetProduct|loadProductsFromDB|getProductFromDB|codes\.Internal|status\.Errorf|QueryContext|QueryRowContext|SELECT" main.go',
            "go build ./...",
        ],
        "hints": [
            "This service's main handlers and database helpers live in `src/product-catalog/main.go`.",
            "For service-level error-rate spikes with sparse alert context, inspect `codes.Internal` paths before speculative refactors.",
            "Homepage and product listing failures usually flow through `ListProducts` -> `loadProductsFromDB`.",
            "Product detail failures usually flow through `GetProduct` -> `getProductFromDB`.",
        ],
        "verify_command": "cd src/product-catalog && go build ./...",
    }
}

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("bridge")

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------
# Dedup cache: set of error hashes that have already been dispatched (fire-once-ever)
_dedup_cache: set[str] = set()

# Dispatch history (most recent first, capped at 200)
_dispatch_history: list[dict] = []
MAX_HISTORY = 200

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _error_hash(service_name: str, error_text: str) -> str:
    """Compute a dedup hash from service name + first 200 chars of error text."""
    raw = f"{service_name}{error_text[:200]}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _is_duplicate(h: str) -> bool:
    """Return True if this hash was already successfully dispatched."""
    return h in _dedup_cache


def _mark_dispatched(h: str) -> None:
    """Mark a hash as successfully dispatched. Fire-once-ever."""
    _dedup_cache.add(h)


def _branch_name(service: str, error_type: str, h: str) -> str:
    """Generate a fix/* branch name."""
    safe_svc = service.replace("/", "-").replace(" ", "-").lower()
    safe_err = error_type.replace("/", "-").replace(" ", "-").lower()[:30]
    return f"fix/{safe_svc}-{safe_err}-{h[:6]}"


def _default_commands(directory: str, language: str) -> list[str]:
    if language == "Go":
        return [
            f"cd {directory}",
            r'rg -n "Internal|status\.Errorf|SetStatus|QueryContext|QueryRowContext|SELECT|UPDATE|INSERT" .',
            "go build ./...",
        ]

    return [
        f"cd {directory}",
        r'rg -n "error|exception|Internal|SELECT|UPDATE|INSERT|Query|status" .',
    ]


def _service_metadata(service: str) -> dict:
    if service in SERVICE_METADATA:
        return SERVICE_METADATA[service]

    directory = f"src/{service}"
    return {
        "directory": directory,
        "language": "unknown",
        "commands": _default_commands(directory, "unknown"),
        "hints": [
            f"Start in `{directory}` and identify the request handlers, entrypoints, or worker loops for `{service}`.",
            "When alert context is sparse, prove a chain of evidence from alert symptom -> handler -> helper -> exact failing line before changing code.",
            "Prefer small logic/query/operator fixes over speculative type or architecture changes.",
        ],
        "verify_command": f"cd {directory}",
    }


def _fetch_splunk_error_context(service: str) -> dict | None:
    """Fetch error metric breakdowns from Splunk Observability Cloud API."""
    if not SPLUNK_API_TOKEN:
        log.info("SPLUNK_API_TOKEN not set — skipping trace enrichment")
        return None

    base_url = f"https://api.{SPLUNK_REALM}.signalfx.com"
    headers = {"X-SF-TOKEN": SPLUNK_API_TOKEN, "Content-Type": "application/json"}

    try:
        import urllib.parse
        mts_query = urllib.parse.quote(
            f"sf_metric:service.request.count AND sf_service:{service} AND sf_error:true"
        )
        resp = requests.get(
            f"{base_url}/v2/metrictimeseries?query={mts_query}&limit=20",
            headers=headers, timeout=10,
        )
        if not resp.ok:
            log.warning("Splunk MTS API returned %s", resp.status_code)
            return None

        results = resp.json().get("results", [])
        if not results:
            return None

        operations: set[str] = set()
        endpoints: set[str] = set()
        error_types: set[str] = set()
        http_methods: set[str] = set()
        for mts in results:
            dims = mts.get("dimensions", {})
            if dims.get("sf_operation"):
                operations.add(dims["sf_operation"])
            if dims.get("sf_endpoint"):
                endpoints.add(dims["sf_endpoint"])
            if dims.get("sf_httpMethod"):
                http_methods.add(dims["sf_httpMethod"])
            if dims.get("exception.type"):
                error_types.add(dims["exception.type"])
            if dims.get("rpc.grpc.status_code"):
                error_types.add(f"gRPC:{dims['rpc.grpc.status_code']}")
            if dims.get("http.response.status_code"):
                error_types.add(f"HTTP:{dims['http.response.status_code']}")

        ctx = {
            "operations": sorted(operations),
            "endpoints": sorted(endpoints),
            "error_types": sorted(error_types),
            "http_methods": sorted(http_methods),
            "mts_count": len(results),
        }
        log.info("Splunk enrichment for %s: %s", service, json.dumps(ctx))
        return ctx
    except Exception as exc:
        log.warning("Splunk enrichment failed (non-fatal): %s", exc)
        return None


def _format_splunk_context(ctx: dict | None) -> str:
    if not ctx:
        return ""
    lines = ["\n### Splunk APM Error Context (live from API)"]
    if ctx["operations"]:
        lines.append(f"**Failing operations:** {', '.join(ctx['operations'])}")
    if ctx["endpoints"]:
        lines.append(f"**Failing endpoints:** {', '.join(ctx['endpoints'])}")
    if ctx["error_types"]:
        lines.append(f"**Error types observed:** {', '.join(ctx['error_types'])}")
    if ctx["http_methods"]:
        lines.append(f"**HTTP methods involved:** {', '.join(ctx['http_methods'])}")
    lines.append(f"**Active error metric time series:** {ctx['mts_count']}")
    return "\n".join(lines)


def _build_devin_prompt(
    source: str,
    detector_name: str,
    service: str,
    severity: str,
    timestamp: str,
    alert_id: str,
    error_details: str,
    branch: str,
    dimensions: dict,
    trigger_value: str,
    splunk_context: dict | None = None,
) -> str:
    metadata = _service_metadata(service)
    commands = "\n".join(metadata["commands"])
    hints = "\n".join(f"- {hint}" for hint in metadata["hints"])
    dimensions_json = json.dumps(dimensions or {}, indent=2, sort_keys=True)

    return f"""## Production Error — Automated Resolution

**Detected by:** {source}
**Detector:** {detector_name or "unknown"}
**Service:** {service}
**Severity:** {severity}
**Timestamp:** {timestamp}
**Alert ID:** {alert_id}

### Error Details
```
{error_details}
```

### Incident Signal
**Triggering value:** {trigger_value or "unknown"}

```json
{dimensions_json}
```

### Repository Context
- Repo: {REPO_URL}
- Branch to create: `{branch}`
- Read first: `docs/DEVIN_CONTEXT.md`
- Service directory: `{metadata["directory"]}`
- Service language: {metadata["language"]}

### Deterministic Investigation Method
1. Read `docs/DEVIN_CONTEXT.md` before editing.
2. Work in `{metadata["directory"]}` unless you find direct evidence the failure originates elsewhere.
3. Identify the handler or entrypoint responsible for the failing behavior in this service.
4. Search for code paths that can emit `Internal`, `5xx`, error spans, or failed queries for this service.
5. Prove a chain of evidence from the alert symptom to a specific handler/helper and exact failing line before making changes.
6. Prefer minimal logic/query/operator fixes over speculative refactors.
7. If you cannot prove the root cause from the repo code, say so explicitly instead of guessing.

### Recommended Commands
```bash
{commands}
```

### Service-Specific Hints
{hints}

### Deliverable
1. Implement a minimal fix on branch `{branch}`.
2. Verify with:
   - `{metadata["verify_command"]}`
3. Open a PR from `{branch}` → `main` with:
   - Root cause analysis tied to exact code lines
   - Why the previous hypotheses were rejected
   - What the fix changes

### Critical
- Branch name MUST be exactly: `{branch}`
- Keep the fix minimal
- Do NOT modify config files, docker-compose files, feature flag definitions, or .env files
- Do NOT invent production-only drift or hidden stack traces unless you can prove them from available evidence
{_format_splunk_context(splunk_context)}
"""


def _dispatch_to_devin(prompt: str, branch: str) -> dict:
    """Create a Devin session via the v3 Organization API."""
    if not DEVIN_API_KEY:
        log.error("DEVIN_API_KEY is not set — cannot dispatch")
        return {"error": "DEVIN_API_KEY not configured"}
    if not DEVIN_ORG_ID:
        log.error("DEVIN_ORG_ID is not set — cannot dispatch")
        return {"error": "DEVIN_ORG_ID not configured"}

    url = f"https://api.devin.ai/v3/organizations/{DEVIN_ORG_ID}/sessions"
    headers = {
        "Authorization": f"Bearer {DEVIN_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "prompt": prompt,
        "idempotent": True,
    }
    if DEVIN_PLAYBOOK_ID:
        payload["playbook_id"] = DEVIN_PLAYBOOK_ID

    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        log.info("Devin session created: %s", data.get("session_id", data))
        return data
    except requests.RequestException as exc:
        log.error("Devin API error: %s", exc)
        return {"error": str(exc)}


def _record_dispatch(source: str, service: str, severity: str,
                     alert_id: str, branch: str, devin_response: dict,
                     error_hash: str):
    """Append to dispatch history."""
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "service": service,
        "severity": severity,
        "alert_id": alert_id,
        "branch": branch,
        "error_hash": error_hash,
        "devin_session_id": devin_response.get("session_id"),
        "devin_error": devin_response.get("error"),
    }
    _dispatch_history.insert(0, entry)
    if len(_dispatch_history) > MAX_HISTORY:
        _dispatch_history.pop()


def _process_alert(source: str, detector_name: str, service: str, error_text: str,
                   severity: str, alert_id: str, dimensions: dict,
                   trigger_value: str) -> dict:
    """Common pipeline: dedup → branch name → prompt → dispatch."""
    h = _error_hash(service, error_text)

    if _is_duplicate(h):
        log.info("Duplicate alert (hash=%s) from %s for %s — skipping",
                 h, source, service)
        return {"status": "duplicate", "error_hash": h}

    error_type = error_text.split("\n")[0][:60] if error_text else "unknown"
    branch = _branch_name(service, error_type, h)
    ts = datetime.now(timezone.utc).isoformat()

    # Enrich with live Splunk data if API token is available
    splunk_context = _fetch_splunk_error_context(service)

    prompt = _build_devin_prompt(
        source=source,
        detector_name=detector_name,
        service=service,
        severity=severity,
        timestamp=ts,
        alert_id=alert_id,
        error_details=error_text,
        branch=branch,
        dimensions=dimensions,
        trigger_value=trigger_value,
        splunk_context=splunk_context,
    )

    log.info("Dispatching to Devin: source=%s service=%s branch=%s hash=%s",
             source, service, branch, h)
    devin_resp = _dispatch_to_devin(prompt, branch)
    _record_dispatch(source, service, severity, alert_id, branch,
                     devin_resp, h)

    if "error" not in devin_resp:
        _mark_dispatched(h)
        log.info("Hash %s marked as dispatched (fire-once-ever)", h)
    else:
        log.warning("Dispatch failed for hash %s — will allow retry on next alert", h)

    return {
        "status": "dispatched" if "error" not in devin_resp else "dispatch_failed",
        "error_hash": h,
        "branch": branch,
        "devin": devin_resp,
    }


# ---------------------------------------------------------------------------
# Webhook Endpoints
# ---------------------------------------------------------------------------

@app.route("/webhook/splunk", methods=["POST"])
def webhook_splunk():
    """Receive Splunk Observability Cloud detector alert."""
    data = request.get_json(silent=True) or {}
    log.info("Received webhook from Splunk: %s", json.dumps(data, indent=2))

    # Extract fields from Splunk detector payload
    detector = data.get("detector", "")
    severity = data.get("severity", "Unknown")
    description = data.get("description", "")
    incident_id = data.get("incidentId", "")

    # Try to extract service name from inputs dimensions
    service = "unknown"
    error_text = description
    dimensions: dict = {}
    trigger_value = ""
    inputs = data.get("inputs", [])
    if inputs and isinstance(inputs, list):
        dims = inputs[0].get("dimensions", {}) if isinstance(inputs[0], dict) else {}
        dimensions = dims
        service = dims.get("sf_service", dims.get("service.name", "unknown"))
        trigger_value = inputs[0].get("value", "")
        if trigger_value:
            error_text = f"{description}\nTriggering value: {trigger_value}"

    if not incident_id:
        incident_id = f"splunk-{hashlib.md5(json.dumps(data, sort_keys=True).encode()).hexdigest()[:12]}"

    result = _process_alert(
        source="Splunk Observability Cloud",
        detector_name=detector,
        service=service,
        error_text=error_text,
        severity=severity,
        alert_id=incident_id,
        dimensions=dimensions,
        trigger_value=trigger_value,
    )
    status_code = 200 if result.get("status") in ("dispatched", "duplicate") else 500
    return jsonify(result), status_code


@app.route("/webhook/grafana", methods=["POST"])
def webhook_grafana():
    """Receive Grafana Cloud alert webhook (stub — Phase 10)."""
    data = request.get_json(silent=True) or {}
    log.info("Received webhook from Grafana: %s", json.dumps(data, indent=2))

    # Grafana webhook payload parsing
    alerts = data.get("alerts", [])
    if not alerts:
        return jsonify({"status": "no_alerts"}), 200

    alert = alerts[0]
    severity = data.get("status", "firing")
    labels = alert.get("labels", {})
    service = labels.get("service_name", labels.get("service.name", "unknown"))
    description = alert.get("annotations", {}).get("description", "")
    alert_id = alert.get("fingerprint", "")

    result = _process_alert(
        source="Grafana Cloud",
        service=service,
        error_text=description,
        severity=severity,
        alert_id=alert_id,
    )
    status_code = 200 if result.get("status") in ("dispatched", "duplicate") else 500
    return jsonify(result), status_code


@app.route("/webhook/honeycomb", methods=["POST"])
def webhook_honeycomb():
    """Receive Honeycomb trigger webhook (stub — Phase 10)."""
    data = request.get_json(silent=True) or {}
    log.info("Received webhook from Honeycomb: %s", json.dumps(data, indent=2))

    trigger_name = data.get("name", "")
    trigger_id = data.get("id", "")
    status = data.get("status", "")
    result_groups = data.get("result_groups", [])

    service = "unknown"
    error_text = f"Trigger: {trigger_name}, Status: {status}"
    if result_groups:
        group = result_groups[0].get("group", {})
        service = group.get("service.name", "unknown")
        result_val = result_groups[0].get("result", "")
        error_text += f"\nResult: {result_val}"

    result = _process_alert(
        source="Honeycomb",
        service=service,
        error_text=error_text,
        severity="Critical" if status == "triggered" else "Info",
        alert_id=trigger_id,
    )
    status_code = 200 if result.get("status") in ("dispatched", "duplicate") else 500
    return jsonify(result), status_code


@app.route("/webhook/newrelic", methods=["POST"])
def webhook_newrelic():
    """Receive New Relic workflow webhook (stub — Phase 10)."""
    data = request.get_json(silent=True) or {}
    log.info("Received webhook from New Relic: %s", json.dumps(data, indent=2))

    # New Relic workflow webhook payload
    condition_name = data.get("condition_name", data.get("conditionName", ""))
    severity = data.get("severity", data.get("priority", "Unknown"))
    details = data.get("details", data.get("violation_chart_url", ""))
    incident_id = str(data.get("incident_id", data.get("incidentId", "")))
    targets = data.get("targets", [])

    service = "unknown"
    error_text = f"Condition: {condition_name}"
    if targets:
        service = targets[0].get("name", "unknown")
        error_text += f"\nTarget: {targets[0]}"
    if details:
        error_text += f"\nDetails: {details}"

    result = _process_alert(
        source="New Relic",
        service=service,
        error_text=error_text,
        severity=severity,
        alert_id=incident_id,
    )
    status_code = 200 if result.get("status") in ("dispatched", "duplicate") else 500
    return jsonify(result), status_code


# ---------------------------------------------------------------------------
# Utility Endpoints
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    """Health check — reports configured backends."""
    return jsonify({
        "status": "ok",
        "backends": {
            "splunk": True,
            "grafana": False,
            "honeycomb": False,
            "newrelic": False,
        },
        "devin_configured": bool(DEVIN_API_KEY),
        "repo_url": REPO_URL,
        "dedup_window_seconds": DEDUP_WINDOW_SECONDS,
    })


@app.route("/history", methods=["GET"])
def history():
    """Return recent dispatch log (last 50 entries)."""
    limit = min(int(request.args.get("limit", 50)), MAX_HISTORY)
    return jsonify(_dispatch_history[:limit])


@app.route("/test", methods=["POST"])
def test_dispatch():
    """Manual test endpoint — accepts JSON and runs through the pipeline."""
    data = request.get_json(silent=True) or {}
    log.info("Test dispatch: %s", json.dumps(data, indent=2))

    result = _process_alert(
        source=data.get("source", "manual-test"),
        service=data.get("service", "test-service"),
        error_text=data.get("error_text", "Test error for validation"),
        severity=data.get("severity", "Info"),
        alert_id=data.get("alert_id", f"test-{int(time.time())}"),
    )
    return jsonify(result)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=True)
