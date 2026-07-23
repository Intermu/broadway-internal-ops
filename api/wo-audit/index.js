const https = require("https");

// WO Audit proxy for the SWA-hosted WO_Audit_Automation.html tool.
//
// The tool batch-audits a WO list: for each work order it asks Claude (connected
// to Umbrava over MCP) to search the WO, read its two most recent notes, and write
// a 1-3 sentence client-ready status note. The browser orchestrates the loop
// (concurrency, retries, resume, edit, download); THIS route is the stateless
// per-WO Anthropic call.
//
// Why a proxy at all: the original tool called api.anthropic.com directly from the
// browser with a pasted `sk-ant-` key. That is (a) CORS-blocked without the
// `anthropic-dangerous-direct-browser-access` header and (b) ships the org key to
// every operator's browser. Here the key (ANTHROPIC_API_KEY app setting) stays
// server-side; the browser calls this route SAME-ORIGIN, so there is no CORS and
// no key exposure. (Repo CLAUDE.md Active Work: "needs an Azure Function proxy for
// the Anthropic key".)
//
// AUTH: this route has NO in-code auth gate, exactly like /api/generate. The SWA
// edge protects it: WO_Audit_Automation.html is served to broadway_employee only,
// and /api/wo-audit falls under the /api/* -> broadway_employee route rule in
// staticwebapp.config.json. A signed-in Broadway employee's AAD session is the gate;
// the browser's same-origin cookie is presented automatically.
//
// HTTP via the `https` module, never global fetch (repo CLAUDE.md Hard Rule 2 - the
// SWA-managed Node runtime does not reliably expose fetch). Fixed Anthropic host, no
// SSRF surface.
//
//   POST /api/wo-audit
//        body { wo: { raw, status, city, state, location, days, assignedTo }, model }
//        -> { ok:true, note:"...", mcpCalls:[...], stopReason:"end_turn" }
//        -> { ok:false, error:"...", stopReason?, status? } on a handled failure

// Only these models may be requested (client dropdown). An unknown/absent value
// falls back to the default rather than erroring - a batch should never hard-stop
// on a stray model string.
const ALLOWED_MODELS = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];
function pickModel(requested) {
  const r = String(requested || "").trim();
  if (ALLOWED_MODELS.indexOf(r) !== -1) return r;
  const def = String(process.env.WO_AUDIT_MODEL || "").trim();
  if (ALLOWED_MODELS.indexOf(def) !== -1) return def;
  return "claude-sonnet-5";
}

const SYSTEM_PROMPT = [
  "You are a work order audit agent connected to Umbrava via MCP.",
  "",
  "For the single work order given:",
  "1. Call search_work_orders with the source job number EXACTLY as given, no modifications.",
  "2. Take the \"id\" from the first result.",
  "3. Call get_work_order_notes with that id EXACTLY ONCE.",
  "4. Read only the 2 most recent notes. Ignore email threads and old history.",
  "5. Write a professional 1-3 sentence client-ready status note.",
  "",
  "Total tool calls: exactly 2 (1 search + 1 get_notes). No other tools.",
  "",
  "Note writing rules:",
  "- Pending scheduling -> scheduling is in progress, state reason if known.",
  "- Materials pending -> materials ordered/in transit, note next action if confirmed.",
  "- Proposal in review -> state proposal status and awaiting approval.",
  "- On-site active -> state progress and next confirmed milestone.",
  "- Waiting on third party/client/vendor -> clearly state the dependency.",
  "- Complete -> state completion, mention closeout items only if confirmed.",
  "- Never invent ETAs, dates, or approvals.",
  "",
  "Return ONLY the note text: 1-3 plain sentences, no preamble, no JSON, no markdown, no quotes.",
].join("\n");

// One Umbrava-connected Anthropic Messages call. Fixed host; MCP server host/token
// come from app settings, not the caller, so there is no SSRF surface.
function anthropicAudit(apiKey, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        host: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "mcp-client-2025-11-20",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs || 180000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          if (buf.length > 5000000) { req.destroy(); reject(new Error("anthropic response too large")); }
        });
        res.on("end", () => {
          let j = null; try { j = JSON.parse(buf); } catch (e) { /* leave null */ }
          resolve({ status: res.statusCode, json: j, raw: buf });
        });
      }
    );
    req.on("timeout", () => { req.destroy(new Error("anthropic request timed out")); });
    req.on("error", reject);
    req.end(payload);
  });
}

function s(v, max) {
  var out = (v == null) ? "" : String(v).trim();
  if (max && out.length > max) out = out.slice(0, max);
  return out;
}

module.exports = async function (context, req) {
  if (req.method !== "POST") { context.res = { status: 405, body: "Method Not Allowed" }; return; }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: { ok: false, error: "ANTHROPIC_API_KEY is not set" } };
      return;
    }

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const wo = (body.wo && typeof body.wo === "object") ? body.wo : null;
    const raw = wo ? s(wo.raw, 64) : "";
    if (!raw) {
      context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { ok: false, error: "missing wo.raw (source job number)" } };
      return;
    }

    const model = pickModel(body.model);

    // Human-readable per-WO facts for the model. All fields sanitized; the model
    // searches on `raw` (the source job number) exactly.
    const loc = [s(wo.location, 200), [s(wo.city, 120), s(wo.state, 40)].filter(Boolean).join(", ")].filter(Boolean).join(" ");
    const userMsg = [
      "Source Job #: " + raw,
      "Status: " + (s(wo.status, 120) || "(unknown)"),
      "Location: " + (loc || "(unknown)"),
      "Days open: " + (s(wo.days, 20) || "(unknown)"),
      "Assigned: " + (s(wo.assignedTo, 200) || "(unknown)"),
      "",
      "Search for this work order using the source job number above, read its two most",
      "recent notes, and return ONLY the client-ready status note.",
    ].join("\n");

    // MCP server + its credential are server-held. authorization_token is attached
    // only when UMBRAVA_MCP_TOKEN is configured (the endpoint may accept unauthenticated
    // calls in some deployments; if reads come back empty, set the token app setting).
    const mcpServer = {
      type: "url",
      name: "Umbrava",
      url: process.env.UMBRAVA_MCP_URL || "https://app.umbrava.com/api/mcp",
    };
    const mcpToken = process.env.UMBRAVA_MCP_TOKEN;
    if (mcpToken) mcpServer.authorization_token = mcpToken;

    const payload = {
      model: model,
      max_tokens: 2000,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
      mcp_servers: [mcpServer],
      tools: [{ type: "mcp_toolset", mcp_server_name: "Umbrava" }],
    };

    const r = await anthropicAudit(apiKey, payload, 180000);
    if (r.status !== 200 || !r.json) {
      context.log.error("wo-audit: Anthropic error", r.status, (r.raw || "").slice(0, 400));
      context.res = {
        status: 502,
        headers: { "Content-Type": "application/json" },
        body: { ok: false, error: "Anthropic API error (" + r.status + ")", detail: (r.raw || "").slice(0, 300) },
      };
      return;
    }

    const msg = r.json;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const note = blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();
    // Surface which MCP tools ran, for the client log (best-effort; block type varies
    // by connector version, so match leniently on "mcp_tool_use").
    const mcpCalls = blocks
      .filter((b) => b && typeof b.type === "string" && b.type.indexOf("mcp_tool_use") !== -1)
      .map((b) => ({ name: b.name || "?", input: JSON.stringify(b.input || {}).slice(0, 120) }));

    context.log("wo-audit", raw, model, "stop=" + msg.stop_reason, "mcp=" + mcpCalls.length, "noteLen=" + note.length);
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { ok: true, note: note, mcpCalls: mcpCalls, stopReason: msg.stop_reason || null },
    };
  } catch (err) {
    const m = (err && err.message) ? err.message : String(err);
    context.log.error("wo-audit error:", m);
    context.res = { status: 500, headers: { "Content-Type": "application/json" }, body: { ok: false, error: m } };
  }
};
