# Self-Healing Bridge Service

A Flask service that receives webhooks from APM tools and dispatches
Devin AI sessions to automatically fix detected production errors.

## Supported APM Tools

| Tool | Endpoint | Status |
|---|---|---|
| Splunk Observability Cloud | `POST /webhook/splunk` | Active |
| Grafana Cloud | `POST /webhook/grafana` | Stub (Phase 10) |
| Honeycomb | `POST /webhook/honeycomb` | Stub (Phase 10) |
| New Relic | `POST /webhook/newrelic` | Stub (Phase 10) |

## Utility Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check with configured backend status |
| `GET /history` | Recent dispatch log (last 50 entries) |
| `POST /test` | Manual test — runs a payload through the full pipeline |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DEVIN_API_KEY` | Yes | — | Devin AI API key |
| `REPO_URL` | Yes | — | GitHub URL of the fork |
| `DEDUP_WINDOW_SECONDS` | No | 3600 | Seconds to suppress duplicate alerts |
| `SPLUNK_WEBHOOK_SECRET` | No | — | Shared secret for Splunk webhook verification |
| `LOG_LEVEL` | No | INFO | Python log level |

## Running Locally

```bash
pip install -r requirements.txt
DEVIN_API_KEY=xxx REPO_URL=https://github.com/your-org/opentelemetry-demo \
  python bridge.py
```

## Running via Docker Compose

The bridge is included in `docker-compose.override.yml` and starts
automatically with `docker compose up`.
