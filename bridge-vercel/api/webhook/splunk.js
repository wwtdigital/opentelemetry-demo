/**
 * Vercel serverless function: receives Splunk Observability Cloud webhook alerts,
 * deduplicates via Upstash Redis (Vercel KV), and dispatches Devin AI sessions.
 */

import { Redis } from "@upstash/redis";

// ---------------------------------------------------------------------------
// Config from Vercel environment variables
// ---------------------------------------------------------------------------
const DEVIN_API_KEY = process.env.DEVIN_API_KEY || "";
const DEVIN_ORG_ID = process.env.DEVIN_ORG_ID || "";
const DEVIN_PLAYBOOK_ID = (process.env.DEVIN_PLAYBOOK_ID || "").trim();
const REPO_URL = process.env.REPO_URL || "";
const SPLUNK_WEBHOOK_SECRET = process.env.SPLUNK_WEBHOOK_SECRET || "";
const SPLUNK_API_TOKEN = process.env.SPLUNK_API_TOKEN || "";
const SPLUNK_REALM = process.env.SPLUNK_REALM || "us1";

// No static service metadata — the playbook handles investigation methodology.

// Vercel KV (Upstash Redis) — set automatically when you add KV store
let redis = null;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256Hex(input) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function errorHash(serviceName, errorText) {
  const raw = `${serviceName}${(errorText || "").slice(0, 200)}`;
  return sha256Hex(raw);
}

function branchName(service, errorType, h) {
  const safeSvc = service.replace(/[/ ]/g, "-").toLowerCase();
  const safeErr = (errorType || "unknown").replace(/[/ ]/g, "-").toLowerCase().slice(0, 30);
  return `fix/${safeSvc}-${safeErr}-${h.slice(0, 6)}`;
}

async function fetchSplunkErrorContext(service) {
  if (!SPLUNK_API_TOKEN) {
    console.log("SPLUNK_API_TOKEN not set — skipping trace enrichment");
    return null;
  }

  const baseUrl = `https://api.${SPLUNK_REALM}.signalfx.com`;
  const headers = { "X-SF-TOKEN": SPLUNK_API_TOKEN, "Content-Type": "application/json" };

  try {
    // Query ALL error MTS for this service (spans, traces, service.request)
    // to get operation-level breakdown, not just the aggregate service metric
    const mtsQuery = encodeURIComponent(
      `sf_service:${service} AND sf_error:true`
    );
    const mtsResp = await fetch(
      `${baseUrl}/v2/metrictimeseries?query=${mtsQuery}&limit=100`,
      { headers }
    );
    if (!mtsResp.ok) {
      console.warn(`Splunk MTS API returned ${mtsResp.status}`);
      return null;
    }
    const mtsData = await mtsResp.json();
    const results = mtsData.results || [];
    if (results.length === 0) return null;

    // Extract operations, span kinds, metrics, and error signals
    const operations = new Set();
    const spanKinds = new Set();
    const metrics = new Set();
    const errorTypes = new Set();
    for (const mts of results) {
      const dims = mts.dimensions || {};
      if (dims.sf_operation) operations.add(dims.sf_operation);
      if (dims.sf_kind) spanKinds.add(dims.sf_kind);
      if (dims["exception.type"]) errorTypes.add(dims["exception.type"]);
      if (dims["rpc.grpc.status_code"]) errorTypes.add(`gRPC:${dims["rpc.grpc.status_code"]}`);
      if (dims["http.response.status_code"]) errorTypes.add(`HTTP:${dims["http.response.status_code"]}`);
      // Track which metrics have error data (spans.count, traces.count, etc.)
      const metric = mts.metric || dims.sf_metric;
      if (metric && !metric.includes("histogram") && !metric.includes("_S1")) metrics.add(metric);
    }

    const context = {
      operations: [...operations],
      spanKinds: [...spanKinds],
      metrics: [...metrics],
      errorTypes: [...errorTypes],
      mtsCount: results.length,
    };
    console.log(`Splunk enrichment for ${service}:`, JSON.stringify(context));
    return context;
  } catch (err) {
    console.warn("Splunk enrichment failed (non-fatal):", err.message);
    return null;
  }
}

function formatSplunkContext(ctx) {
  if (!ctx) return "Splunk API returned no additional error breakdown.";
  const lines = [];
  if (ctx.operations.length > 0)
    lines.push(`Failing operations: ${ctx.operations.join(", ")}`);
  if (ctx.spanKinds && ctx.spanKinds.length > 0)
    lines.push(`Span kinds: ${ctx.spanKinds.join(", ")}`);
  if (ctx.errorTypes.length > 0)
    lines.push(`Error types: ${ctx.errorTypes.join(", ")}`);
  if (ctx.metrics && ctx.metrics.length > 0)
    lines.push(`Error metrics present: ${ctx.metrics.join(", ")}`);
  lines.push(`Total error MTS: ${ctx.mtsCount}`);
  return lines.length > 0 ? lines.join("\n") : "No error breakdown available.";
}

function buildDevinPrompt({
  source,
  detectorName,
  service,
  severity,
  timestamp,
  alertId,
  errorDetails,
  branch,
  dimensions,
  triggerValue,
  splunkContext,
}) {
  const dimensionsJson = JSON.stringify(dimensions || {}, null, 2);

  return `## Production Alert

**Source:** ${source}
**Detector:** ${detectorName || "unknown"}
**Service:** ${service}
**Severity:** ${severity}
**Timestamp:** ${timestamp}
**Alert ID:** ${alertId}
**Trigger value:** ${triggerValue || "unknown"}

### Alert description
${errorDetails}

### Dimensions
${dimensionsJson}

### Splunk APM error breakdown
${formatSplunkContext(splunkContext)}

### Task
Fix the production bug in **${service}** in repo ${REPO_URL}.
Use branch \`${branch}\`.
`;
}

async function dispatchToDevin(prompt) {
  if (!DEVIN_API_KEY) return { error: "DEVIN_API_KEY not configured" };
  if (!DEVIN_ORG_ID) return { error: "DEVIN_ORG_ID not configured" };

  const url = `https://api.devin.ai/v3/organizations/${DEVIN_ORG_ID}/sessions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEVIN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      idempotent: true,
      ...(DEVIN_PLAYBOOK_ID ? { playbook_id: DEVIN_PLAYBOOK_ID } : {}),
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Devin API error: ${resp.status} ${text}`);
    return { error: `${resp.status}: ${text}` };
  }

  const data = await resp.json();
  console.log("Devin session created:", data.session_id || JSON.stringify(data));
  return data;
}

// ---------------------------------------------------------------------------
// KV helpers — incident → session mapping with 24h TTL
// ---------------------------------------------------------------------------

const INCIDENT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

async function getIncidentSession(incidentId) {
  if (!redis) return null;
  try {
    return await redis.get(`bridge:incident:${incidentId}`);
  } catch (err) {
    console.error("KV get failed:", err);
    return null;
  }
}

async function storeIncidentSession(incidentId, sessionId) {
  if (!redis) return;
  try {
    await redis.set(`bridge:incident:${incidentId}`, sessionId, {
      ex: INCIDENT_TTL_SECONDS,
    });
  } catch (err) {
    console.error("KV set failed:", err);
  }
}

async function sendSessionMessage(sessionId, message) {
  const url = `https://api.devin.ai/v3/organizations/${DEVIN_ORG_ID}/sessions/${sessionId}/messages`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEVIN_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Devin message API error: ${resp.status} ${text}`);
    return { error: `${resp.status}: ${text}` };
  }

  const data = await resp.json();
  console.log(`Message sent to session ${sessionId}`);
  return data;
}

// ---------------------------------------------------------------------------
// Main processing pipeline
// ---------------------------------------------------------------------------

async function processAlert({
  source,
  detectorName,
  service,
  errorText,
  severity,
  alertId,
  dimensions,
  triggerValue,
}) {
  const timestamp = new Date().toISOString();

  // Check if this incident already has a Devin session
  const existingSessionId = await getIncidentSession(alertId);

  if (existingSessionId) {
    // Reminder firing — message the existing session instead of creating a new one
    console.log(`Incident ${alertId} already mapped to session ${existingSessionId} — sending update`);
    const splunkContext = await fetchSplunkErrorContext(service);
    const message = `⚠️ **Alert still firing** (${timestamp})

**Severity:** ${severity}
**Service:** ${service}
**Trigger value:** ${triggerValue || "unknown"}

### Latest Splunk APM error breakdown
${formatSplunkContext(splunkContext)}

The alert has not cleared. If you've already opened a PR, verify the fix addresses the issue. If not, continue investigating.`;

    const msgResp = await sendSessionMessage(existingSessionId, message);
    return {
      status: msgResp.error ? "message_failed" : "message_sent",
      incident_id: alertId,
      session_id: existingSessionId,
      devin: msgResp,
    };
  }

  // First firing — create a new Devin session
  const h = await errorHash(service, errorText);
  const errorType = errorText ? errorText.split("\n")[0].slice(0, 60) : "unknown";
  const branch = branchName(service, errorType, h);

  const splunkContext = await fetchSplunkErrorContext(service);

  const prompt = buildDevinPrompt({
    source,
    detectorName,
    service,
    severity,
    timestamp,
    alertId,
    errorDetails: errorText,
    branch,
    dimensions,
    triggerValue,
    splunkContext,
  });

  console.log(`Dispatching to Devin: service=${service} branch=${branch} incident=${alertId}`);
  const devinResp = await dispatchToDevin(prompt);

  if (!devinResp.error && devinResp.session_id) {
    await storeIncidentSession(alertId, devinResp.session_id);
    console.log(`Incident ${alertId} → session ${devinResp.session_id} (TTL 24h)`);
  } else {
    console.warn(`Dispatch failed for incident ${alertId} — will retry on next firing`);
  }

  return {
    status: devinResp.error ? "dispatch_failed" : "dispatched",
    incident_id: alertId,
    branch,
    devin: devinResp,
  };
}

// ---------------------------------------------------------------------------
// Vercel Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", endpoint: "/webhook/splunk", method: "POST" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const data = req.body || {};
  console.log("Received webhook from Splunk:", JSON.stringify(data, null, 2));

  // Skip clear/ok events — only process fire events
  const status = (data.status || "").toLowerCase();
  if (status === "ok" || status === "stopped" || status === "manually resolved") {
    console.log(`Skipping non-fire event (status=${data.status})`);
    return res.status(200).json({ status: "skipped", reason: `alert status: ${data.status}` });
  }

  // Extract fields from Splunk detector payload
  const severity = data.severity || "Unknown";
  const detector = data.detector || "";
  const description = data.description || data.messageBody || "";
  const incidentId = data.incidentId || "";

  // Extract service name and dimensions from inputs, falling back to top-level dimensions
  let service = "unknown";
  let errorText = description;
  let dimensions = data.dimensions || {};
  let triggerValue = "";
  const inputs = data.inputs || [];
  if (Array.isArray(inputs) && inputs.length > 0 && typeof inputs[0] === "object") {
    const inputDims = inputs[0].dimensions || {};
    // Merge input dimensions into top-level dimensions
    dimensions = { ...dimensions, ...inputDims };
    triggerValue = inputs[0].value || "";
    if (triggerValue) {
      errorText = `${description}\nTriggering value: ${triggerValue}`;
    }
  }
  service = dimensions.sf_service || dimensions["service.name"] || "unknown";

  const alertId =
    incidentId ||
    `splunk-${await sha256Hex(JSON.stringify(data)).then((h) => h.slice(0, 12))}`;

  const result = await processAlert({
    source: "Splunk Observability Cloud",
    detectorName: detector,
    service,
    errorText,
    severity,
    alertId,
    dimensions,
    triggerValue,
  });

  return res.status(200).json(result);
}
