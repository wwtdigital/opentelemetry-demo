export default function handler(req, res) {
  res.status(200).json({
    service: "self-healing-bridge",
    config: {
      devin_api_key: process.env.DEVIN_API_KEY ? "set" : "MISSING",
      devin_org_id: process.env.DEVIN_ORG_ID ? "set" : "MISSING",
      repo_url: process.env.REPO_URL || "MISSING",
      kv_configured: !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
      webhook_secret: process.env.SPLUNK_WEBHOOK_SECRET ? "set" : "MISSING",
    },
  });
}
