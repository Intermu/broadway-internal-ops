const Anthropic = require("@anthropic-ai/sdk");

// Phase 2 schema inference. The agent calls this only when its static alias
// map can't place a metric-critical column. We send the canonical fields that
// went unmapped, the file's actual header names, and 1-2 sample values per
// header; Sonnet returns a best-guess mapping. The agent re-validates every
// suggestion (header must be one we sent) and only auto-applies high-confidence
// ones, so a wrong or hallucinated answer here can't silently corrupt metrics.
module.exports = async function (context, req) {
  if (req.method !== "POST") {
    context.res = { status: 405, body: "Method Not Allowed" };
    return;
  }

  try {
    const body = req.body || {};
    const unmapped = Array.isArray(body.unmapped) ? body.unmapped : [];
    const headers = Array.isArray(body.headers) ? body.headers : [];
    const samples = (body.samples && typeof body.samples === "object") ? body.samples : {};

    // Nothing to infer, or nothing to infer against - return an empty mapping
    // rather than burning a model call.
    if (!unmapped.length || !headers.length) {
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { mappings: [] },
      };
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

    // Compact sample block: "Header" -> ["v1","v2"]
    const sampleLines = headers
      .map(function (h) {
        const vals = Array.isArray(samples[h]) ? samples[h].slice(0, 2) : [];
        return "  " + JSON.stringify(h) + " -> " + JSON.stringify(vals);
      })
      .join("\n");

    const system =
      "You map spreadsheet column headers from a field-service Work Order export " +
      "to a fixed set of canonical fields. You will be given the canonical fields " +
      "that still need a column, the file's actual header names, and up to two " +
      "sample values per header. For each canonical field, pick the single best " +
      "matching header from the provided list, or omit it if nothing fits. " +
      "Rules: only use headers from the provided list verbatim; never invent a " +
      "header; map each header to at most one canonical field; give a confidence " +
      "from 0 to 1. Field meanings: " +
      "'Job ID'=work order / job number; " +
      "'Status'=current work order status text; " +
      "'Aged'=age of the job in days (a number); " +
      "'Status Hrs'=hours spent in the current status (a number); " +
      "'Amount'=dollar amount / client not-to-exceed / cost; " +
      "'Assigned To'=the coordinator or person assigned; " +
      "'Last Note Date'=date of the most recent note; " +
      "'Expected Completion Date'=expected or target completion date. " +
      "Respond with ONLY a JSON object, no prose and no markdown fences, shaped " +
      'exactly: {"mappings":[{"canonical":"<field>","header":"<header>","confidence":<0..1>}]}';

    const user =
      "Canonical fields needing a column:\n" +
      JSON.stringify(unmapped) +
      "\n\nFile headers with sample values:\n" +
      sampleLines;

    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: process.env.INFER_SCHEMA_MODEL || process.env.GENERATE_MODEL || "claude-sonnet-4-6",
      max_tokens: 600,
      system: system,
      messages: [{ role: "user", content: user }],
    });

    const outText = Array.isArray(msg.content)
      ? msg.content.filter(function (b) { return b && b.type === "text"; }).map(function (b) { return b.text; }).join("")
      : "";

    // Defensive parse: strip any accidental code fences, then JSON.parse. On any
    // failure, return an empty mapping so the client degrades to Phase-1 behavior.
    let mappings = [];
    try {
      const cleaned = outText.replace(/```json/gi, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && Array.isArray(parsed.mappings)) {
        const headerSet = new Set(headers);
        const unmappedSet = new Set(unmapped);
        const usedHeaders = new Set();
        mappings = parsed.mappings.filter(function (m) {
          if (!m || typeof m.canonical !== "string" || typeof m.header !== "string") return false;
          if (!unmappedSet.has(m.canonical)) return false;   // only fields we asked about
          if (!headerSet.has(m.header)) return false;          // never trust an invented header
          if (usedHeaders.has(m.header)) return false;         // one header -> one field
          usedHeaders.add(m.header);
          return true;
        }).map(function (m) {
          var c = typeof m.confidence === "number" ? m.confidence : 0;
          if (c < 0) c = 0; if (c > 1) c = 1;
          return { canonical: m.canonical, header: m.header, confidence: c };
        });
      }
    } catch (parseErr) {
      context.log.warn("infer-schema: could not parse model output:", parseErr && parseErr.message);
      mappings = [];
    }

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { mappings: mappings },
    };
  } catch (err) {
    context.log.error("infer-schema error:", err);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { error: err.message },
    };
  }
};
