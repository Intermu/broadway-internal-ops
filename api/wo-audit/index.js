const https = require("https");

// WO Audit SUMMARIZE proxy for the BWN suite userscript (bwn-wo-audit.user.js).
//
// v2 (2026-07-23) - direct-GraphQL rebuild. The old v1 of this route asked Claude to
// reach Umbrava over an MCP connector; that failed in production with a 400
// "Authentication error while..." because Umbrava's MCP endpoint only accepts a
// LIVE-SESSION Auth0 bearer (no static/service token), which a server-side Function
// does not have. See the vault note [[wo-audit-automation]].
//
// v2 moves the Umbrava read INTO the page: bwn-wo-audit.user.js runs on app.umbrava.com,
// so it already holds the operator's live Auth0 bearer and fetches each WO's notes with a
// plain same-origin GraphQL call (the same woToJob flow bwn-suite-ai uses for drafts). This
// route no longer touches Umbrava AT ALL - it receives the already-fetched note text and
// only asks Claude to write the 1-3 sentence client-ready status note. The Anthropic key
// stays server-side; no key and no MCP anywhere.
//
// AUTH: the userscript runs on app.umbrava.com (a different origin, NOT federated to
// Broadway's Entra tenant) and calls this route cross-origin via GM_xmlhttpRequest, so it
// cannot present the AAD principal the rest of /api/* relies on. This route is therefore
// reachable ANONYMOUSLY at the SWA route layer (see staticwebapp.config.json) and gates
// itself with the shared connector key (app setting WO_INGEST_KEY, sent as `x-bwn-key`) -
// the SAME key the rest of the connector uses (wo-ingest, cc-auth, user-role, ...). A batch
// summarize over WO notes the caller already has read access to is a coordinator action, so
// there is no minimum rank - the shared key is the tenant gate.
//
// HTTP via the `https` module, never global fetch (repo CLAUDE.md Hard Rule 2 - the
// SWA-managed Node runtime does not reliably expose fetch). Fixed Anthropic host, no SSRF.
//
//   POST /api/wo-audit   header x-bwn-key: <WO_INGEST_KEY>
//        body { wo:{ raw, number, status, city, state, location, days, assignedTo },
//               notes:[ { content, createdDate, type, isPinned } ],   // newest first, <=2 used
//               model }
//        -> { ok:true, note:"...", usedNotes:N }
//        -> { ok:false, error:"..." } on a handled failure

// CORS: Tampermonkey's GM_xmlhttpRequest bypasses same-origin (that's what @connect
// authorizes), so these are belt-and-suspenders - they scope any normal-fetch caller to the
// Umbrava origin. Mirrors cc-auth / wo-ingest.
const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}

// Only these models may be requested (client dropdown). An unknown/absent value falls back
// to the default rather than erroring - a batch should never hard-stop on a stray string.
const ALLOWED_MODELS = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];
function pickModel(requested) {
  const r = String(requested || "").trim();
  if (ALLOWED_MODELS.indexOf(r) !== -1) return r;
  const def = String(process.env.WO_AUDIT_MODEL || "").trim();
  if (ALLOWED_MODELS.indexOf(def) !== -1) return def;
  return "claude-sonnet-5";
}

// The notes are now SUPPLIED (fetched in-page), so the model does no tool calls - it only
// writes the status note from the two most recent notes it is given.
const SYSTEM_PROMPT = [
  "You are a work order audit assistant for a facilities-maintenance company.",
  "",
  "You are given one work order's header facts and its most recent notes (newest first).",
  "Write a professional 1-3 sentence client-ready status note describing where the work",
  "order stands right now, based ONLY on the notes and facts provided.",
  "",
  "Note writing rules:",
  "- Pending scheduling -> scheduling is in progress, state reason if known.",
  "- Materials pending -> materials ordered/in transit, note next action if confirmed.",
  "- Proposal in review -> state proposal status and awaiting approval.",
  "- On-site active -> state progress and next confirmed milestone.",
  "- Waiting on third party/client/vendor -> clearly state the dependency.",
  "- Complete -> state completion, mention closeout items only if confirmed.",
  "- Never invent ETAs, dates, approvals, or facts not present in the notes.",
  "- If the notes are empty or say nothing about status, say so plainly",
  "  (e.g. \"No recent status notes on file.\") - do NOT fabricate a status.",
  "",
  "Return ONLY the note text: 1-3 plain sentences, no preamble, no JSON, no markdown, no quotes.",
].join("\n");

// One plain Anthropic Messages call (no MCP, no tools). Fixed host, no SSRF surface.
function anthropicMessages(apiKey, body, timeoutMs) {
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
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs || 60000,
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
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }
    if (req.method !== "POST") { context.res = json(405, { ok: false, error: "Method Not Allowed" }); return; }

    // -- Key gate (fail closed). 403 not 401: responseOverrides rewrites 401 into a login
    //    redirect a client would misread as success. --------------------------------------
    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { ok: false, error: "connector not configured" }); return; }
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!key || key !== expected) { context.res = json(403, { ok: false, error: "unauthorized" }); return; }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { context.res = json(503, { ok: false, error: "ANTHROPIC_API_KEY is not set" }); return; }

    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const wo = (body.wo && typeof body.wo === "object") ? body.wo : {};
    const raw = s(wo.raw, 64) || s(wo.number, 64);
    if (!raw) { context.res = json(400, { ok: false, error: "missing wo.raw / wo.number" }); return; }

    const model = pickModel(body.model);

    // The two most recent notes, sanitized. The client sorts newest-first and sends the top
    // few; we defensively re-slice to 2 and cap length so a giant note can't blow the prompt.
    const notesIn = Array.isArray(body.notes) ? body.notes.slice(0, 2) : [];
    const noteLines = notesIn.map(function (n, i) {
      n = (n && typeof n === "object") ? n : {};
      const when = s(n.createdDate, 40);
      const type = s(n.type, 40);
      const txt = s(n.content, 4000);
      const head = "Note " + (i + 1) + (when ? " (" + when + ")" : "") + (type ? " [" + type + "]" : "") + ":";
      return head + "\n" + (txt || "(empty)");
    });

    const loc = [s(wo.location, 200), [s(wo.city, 120), s(wo.state, 40)].filter(Boolean).join(", ")].filter(Boolean).join(" ");
    const userMsg = [
      "WO #: " + raw,
      "Status: " + (s(wo.status, 120) || "(unknown)"),
      "Location: " + (loc || "(unknown)"),
      "Days open: " + (s(wo.days, 20) || "(unknown)"),
      "Assigned: " + (s(wo.assignedTo, 200) || "(unknown)"),
      "",
      "Most recent notes (newest first):",
      noteLines.length ? noteLines.join("\n\n") : "(no notes provided)",
      "",
      "Write ONLY the 1-3 sentence client-ready status note.",
    ].join("\n");

    const payload = {
      model: model,
      max_tokens: 400,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    };

    const r = await anthropicMessages(apiKey, payload, 60000);
    if (r.status !== 200 || !r.json) {
      context.log.error("wo-audit: Anthropic error", r.status, (r.raw || "").slice(0, 400));
      context.res = json(502, { ok: false, error: "Anthropic API error (" + r.status + ")", detail: (r.raw || "").slice(0, 300) });
      return;
    }

    const msg = r.json;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const note = blocks.filter((b) => b && b.type === "text").map((b) => b.text).join("\n").trim();

    context.log("wo-audit", raw, model, "stop=" + msg.stop_reason, "usedNotes=" + noteLines.length, "noteLen=" + note.length);
    context.res = json(200, { ok: true, note: note, usedNotes: noteLines.length, stopReason: msg.stop_reason || null });
  } catch (err) {
    const m = (err && err.message) ? err.message : String(err);
    context.log.error("wo-audit error:", m);
    context.res = json(500, { ok: false, error: m });
  }
};
