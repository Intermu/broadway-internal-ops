const https = require("https");

// Anthropic Messages call over the `https` module (NOT the @anthropic-ai/sdk,
// which does its HTTP via global fetch - the SWA-managed Node runtime does not
// reliably expose fetch, and CLAUDE.md forbids fetch / HTTP libraries in
// Functions). Fixed host, no SSRF surface.
function anthropicMessages(apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
      timeout: 60000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; if (buf.length > 5000000) { req.destroy(); reject(new Error("anthropic response too large")); } });
      res.on("end", () => {
        let j = null; try { j = JSON.parse(buf); } catch (e) { /* leave null */ }
        resolve({ status: res.statusCode, json: j, raw: buf });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("anthropic request timed out")); });
    req.on("error", reject);
    req.end(payload);
  });
}

module.exports = async function (context, req) {
  if (req.method !== "POST") {
    context.res = { status: 405, body: "Method Not Allowed" };
    return;
  }

  try {
    const { prompt } = req.body || {};
    if (!prompt) {
      context.res = { status: 400, body: "Missing prompt" };
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      context.res = {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: "ANTHROPIC_API_KEY environment variable is not set" },
      };
      return;
    }

    const r = await anthropicMessages(apiKey, {
      model: process.env.GENERATE_MODEL || "claude-sonnet-4-6",
      max_tokens: 5000,
      messages: [{ role: "user", content: prompt }],
    });
    if (r.status !== 200 || !r.json) {
      context.log.error("generate: Anthropic API error", r.status, (r.raw || "").slice(0, 500));
      context.res = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: { error: "Anthropic API error", status: r.status },
      };
      return;
    }

    const msg = r.json;
    const outText = Array.isArray(msg.content)
      ? msg.content.filter(function (b) { return b && b.type === "text"; }).map(function (b) { return b.text; }).join("")
      : "";
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { text: outText },
    };
  } catch (err) {
    context.log.error("generate error:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: "generate error" },
    };
  }
};
