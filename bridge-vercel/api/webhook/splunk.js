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
    // Find which operations are producing errors for this service
    const mtsQuery = encodeURIComponent(
      `sf_metric:service.request.count AND sf_service:${service} AND sf_error:true`
    );
    const mtsResp = await fetch(
      `${baseUrl}/v2/metrictimeseries?query=${mtsQuery}&limit=20`,
      { headers }
    );
    if (!mtsResp.ok) {
      console.warn(`Splunk MTS API returned ${mtsResp.status}`);
      return null;
    }
    const mtsData = await mtsResp.json();
    const results = mtsData.results || [];
    if (results.length === 0) return null;

    // Extract unique operations, endpoints, and error types
    const operations = new Set();
    const endpoints = new Set();
    const errorTypes = new Set();
    const httpMethods = new Set();
    for (const mts of results) {
      const dims = mts.dimensions || {};
      if (dims.sf_operation) operations.add(dims.sf_operation);
      if (dims.sf_endpoint) endpoints.add(dims.sf_endpoint);
      if (dims.sf_httpMethod) httpMethods.add(dims.sf_httpMethod);
      if (dims["exception.type"]) errorTypes.add(dims["exception.type"]);
      if (dims["rpc.grpc.status_code"]) errorTypes.add(`gRPC:${dims["rpc.grpc.status_code"]}`);
      if (dims["http.response.status_code"]) errorTypes.add(`HTTP:${dims["http.response.status_code"]}`);
    }

    const context = {
      operations: [...operations],
      endpoints: [...endpoints],
      errorTypes: [...errorTypes],
      httpMethods: [...httpMethods],
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
  if (ctx.endpoints.length > 0)
    lines.push(`Failing endpoints: ${ctx.endpoints.join(", ")}`);
  if (ctx.errorTypes.length > 0)
    lines.push(`Error types: ${ctx.errorTypes.join(", ")}`);
  if (ctx.httpMethods.length > 0)
    lines.push(`HTTP methods: ${ctx.httpMethods.join(", ")}`);
  if (ctx.mtsCount)
    lines.push(`Active error metric time series: ${ctx.mtsCount}`);
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
      advanced_mode: "create",
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
// KV helpers (fire-once-ever dedup)
// ---------------------------------------------------------------------------

async function isDuplicate(key) {
  if (!redis) {
    console.warn("KV not configured — dedup disabled, allowing dispatch");
    return false;
  }
  try {
    const exists = await redis.exists(key);
    return exists >= 1;
  } catch (err) {
    console.error("KV exists check failed:", err, "— allowing dispatch");
    return false;
  }
}

async function markDispatched(key) {
  if (!redis) return;
  try {
    await redis.set(key, "1");
  } catch (err) {
    console.error("KV set failed:", err);
  }
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
  const h = await errorHash(service, errorText);
  const dedupKey = `bridge:dispatched:${h}`;

  if (await isDuplicate(dedupKey)) {
    console.log(`Duplicate alert (hash=${h}) for ${service} — skipping`);
    return { status: "duplicate", error_hash: h };
  }

  const errorType = errorText ? errorText.split("\n")[0].slice(0, 60) : "unknown";
  const branch = branchName(service, errorType, h);
  const timestamp = new Date().toISOString();

  // Enrich with live Splunk data if API token is available
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

  console.log(`Dispatching to Devin: service=${service} branch=${branch} hash=${h}`);
  const devinResp = await dispatchToDevin(prompt);

  if (!devinResp.error) {
    await markDispatched(dedupKey);
    console.log(`Hash ${h} marked as dispatched (fire-once-ever)`);
  } else {
    console.warn(`Dispatch failed for hash ${h} — will allow retry on next alert`);
  }

  return {
    status: devinResp.error ? "dispatch_failed" : "dispatched",
    error_hash: h,
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

  // Extract fields from Splunk detector payload
  const severity = data.severity || "Unknown";
  const detector = data.detector || "";
  const description = data.description || "";
  const incidentId = data.incidentId || "";

  // Extract service name from inputs dimensions
  let service = "unknown";
  let errorText = description;
  let dimensions = {};
  let triggerValue = "";
  const inputs = data.inputs || [];
  if (Array.isArray(inputs) && inputs.length > 0 && typeof inputs[0] === "object") {
    const dims = inputs[0].dimensions || {};
    dimensions = dims;
    service = dims.sf_service || dims["service.name"] || "unknown";
    triggerValue = inputs[0].value || "";
    if (triggerValue) {
      errorText = `${description}\nTriggering value: ${triggerValue}`;
    }
  }

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
