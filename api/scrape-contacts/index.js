const https = require("https");
const http = require("http");
const dns = require("dns");
const net = require("net");
const { URL } = require("url");
const AUTH = require("../shared/umbrava-auth.js");

// Contact-email scraper for the BWN Bid-Out userscript. Given a list of vendor website
// URLs (discovered via Google Places), fetch each site server-side and extract any
// contact email printed in the served HTML - so net-new vendors (not in Umbrava) can be
// invited to bid. Returns ONLY emails, never page content.
//
// Reached ANONYMOUSLY at the SWA route layer (Umbrava is a different origin, not federated
// to Broadway AAD) and gated by the SAME shared function key as wo-ingest (x-bwn-key vs
// app setting WO_INGEST_KEY). Fails CLOSED: 503 if the key is unset, 403 on a bad key.
//
// SSRF-hardened: only http/https + standard ports; a custom DNS lookup rejects any host
// that resolves to a private/reserved/link-local address (blocks localhost, RFC1918, CGNAT,
// 169.254 cloud-metadata, IPv6 ULA/link-local, v4-mapped) - enforced at the socket for the
// homepage AND every redirect hop, so DNS-rebinding can't reach internal targets. Per-site
// timeout + byte cap + redirect cap, an overall wall-clock deadline, and a URL cap.

const MAX_URLS = 20;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 7000;
const MAX_BYTES = 800000;
const CONCURRENCY = 6;
const MAX_EMAILS_PER_SITE = 5;
const OVERALL_DEADLINE_MS = 35000;
const UA = "Mozilla/5.0 (compatible; BWN-BidOut/1.0; contact-email lookup)";

const CORS = {
  "Access-Control-Allow-Origin": "https://app.umbrava.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-bwn-key",
  "Vary": "Origin",
};
function json(status, body) {
  return { status, headers: Object.assign({ "Content-Type": "application/json" }, CORS), body };
}

function isPrivateV4(ip) {
  var p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(function (n) { return isNaN(n) || n < 0 || n > 255; })) return true;
  var a = p[0], b = p[1];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;                 // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
  if (a >= 224) return true;                               // multicast/reserved
  return false;
}
function isPrivateV6(ip) {
  ip = ip.toLowerCase();
  if (ip === "::1" || ip === "::" || ip === "0:0:0:0:0:0:0:1") return true;
  if (/^f[cd]/.test(ip)) return true;                      // fc00::/7 ULA
  if (/^fe[89ab]/.test(ip)) return true;                   // fe80::/10 link-local
  var m = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);        // v4-mapped
  if (m) return isPrivateV4(m[1]);
  return false;
}
function ipIsPrivate(ip, family) { return family === 6 ? isPrivateV6(ip) : isPrivateV4(ip); }

// Custom lookup: resolve, and error out if ANY resolved address is private/reserved.
// Passed to http(s).request so the actual socket target is validated (no TOCTOU gap).
function guardedLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  dns.lookup(hostname, { all: true }, function (err, addrs) {
    if (err) return cb(err);
    if (!addrs || !addrs.length) return cb(new Error("no-address"));
    for (var i = 0; i < addrs.length; i++) {
      if (ipIsPrivate(addrs[i].address, addrs[i].family)) return cb(new Error("blocked-private-ip"));
    }
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

function preflightHost(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "bad-scheme";
  if (url.port && url.port !== "80" && url.port !== "443") return "bad-port";
  var host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") return "blocked-host";
  if (net.isIP(host) && ipIsPrivate(host, net.isIPv6(host) ? 6 : 4)) return "blocked-ip";
  return null;
}

function fetchText(urlStr) {
  return new Promise(function (resolve) {
    var hops = 0;
    function go(u) {
      var url; try { url = new URL(u); } catch (e) { return resolve({ error: "bad-url" }); }
      var bad = preflightHost(url); if (bad) return resolve({ error: bad });
      var lib = url.protocol === "https:" ? https : http;
      var done = false, received = 0, chunks = [];
      function finish(v) { if (!done) { done = true; resolve(v); } }
      var req;
      try {
        req = lib.request(url, { method: "GET", lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS, headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,text/plain" } }, function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.destroy();
            if (hops++ >= MAX_REDIRECTS) return finish({ error: "too-many-redirects" });
            var next; try { next = new URL(res.headers.location, url).href; } catch (e) { return finish({ error: "bad-redirect" }); }
            return go(next);
          }
          if (res.statusCode !== 200) { res.destroy(); return finish({ error: "http-" + res.statusCode }); }
          var ct = res.headers["content-type"] || "";
          if (!/text\/html|application\/xhtml|text\/plain/i.test(ct)) { res.destroy(); return finish({ error: "not-html" }); }
          res.on("data", function (c) {
            if (done) return;
            received += c.length;
            if (received <= MAX_BYTES) chunks.push(c);
            else { res.destroy(); finish({ text: Buffer.concat(chunks).toString("utf-8") }); }
          });
          res.on("end", function () { finish({ text: Buffer.concat(chunks).toString("utf-8") }); });
          res.on("error", function () { finish(chunks.length ? { text: Buffer.concat(chunks).toString("utf-8") } : { error: "res-error" }); });
          res.on("close", function () { finish(chunks.length ? { text: Buffer.concat(chunks).toString("utf-8") } : { error: "closed" }); });
        });
      } catch (e) { return finish({ error: "request-throw" }); }
      req.on("timeout", function () { req.destroy(); finish({ error: "timeout" }); });
      req.on("error", function (e) { finish({ error: "req-" + ((e && e.code) || "err") }); });
      req.end();
    }
    go(urlStr);
  });
}

function extractEmails(html, host) {
  var found = new Map();
  var siteDomain = String(host || "").toLowerCase().replace(/^www\./, "");
  function score(e) {
    var d = e.split("@")[1] || "";
    var same = siteDomain && (d === siteDomain || d.endsWith("." + siteDomain) || siteDomain.endsWith("." + d));
    return same ? 0 : 1;   // prefer same-domain addresses
  }
  function valid(e) {
    if (!e || e.length > 100) return false;
    if (/\.(png|jpe?g|gif|svg|webp|css|js|ico)$/i.test(e)) return false;      // asset noise (logo@2x.png)
    if (/@(?:2x|3x)\b/i.test(e)) return false;
    if (/(?:example\.(?:com|org)|sentry\.|\.wixpress\.com|\.godaddy|\.squarespace|schema\.org|@sentry|\.png|\.jpg|u00|x22)/i.test(e)) return false;
    return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(e);
  }
  function add(raw) {
    var e = String(raw || "").trim().toLowerCase().replace(/[.,;:)]+$/, "");
    if (valid(e) && !found.has(e)) found.set(e, score(e));
  }
  (html.match(/mailto:([^"'?\s>&]+)/gi) || []).forEach(function (m) { add(m.replace(/^mailto:/i, "")); });
  (html.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || []).forEach(add);
  return Array.from(found.entries()).sort(function (a, b) { return a[1] - b[1]; }).map(function (x) { return x[0]; }).slice(0, MAX_EMAILS_PER_SITE);
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") { context.res = { status: 204, headers: CORS }; return; }

    const expected = process.env.WO_INGEST_KEY;
    if (!expected) { context.res = json(503, { error: "scrape not configured" }); return; }
    const key = req.headers && (req.headers["x-bwn-key"] || req.headers["X-BWN-KEY"]);
    if (!AUTH.safeStrEqual(key, expected)) { context.res = json(403, { error: "unauthorized" }); return; }

    const body = req.body || {};
    let urls = Array.isArray(body.urls) ? body.urls.map(String).filter(Boolean) : [];
    urls = Array.from(new Set(urls)).slice(0, MAX_URLS);
    if (!urls.length) { context.res = json(400, { error: "no urls" }); return; }

    const deadline = Date.now() + OVERALL_DEADLINE_MS;
    const results = {};
    let idx = 0;
    async function worker() {
      while (idx < urls.length) {
        const target = urls[idx++];
        if (Date.now() > deadline) { results[target] = { emails: [], error: "deadline" }; continue; }
        let host = "";
        try { host = new URL(target).hostname; } catch (e) { results[target] = { emails: [], error: "bad-url" }; continue; }
        const r = await fetchText(target);
        if (r.error) { results[target] = { emails: [], error: r.error }; continue; }
        let emails = extractEmails(r.text, host);
        // If the homepage has none, try a /contact page once (still under the deadline).
        if (!emails.length && Date.now() < deadline) {
          try {
            const c = await fetchText(new URL("/contact", new URL(target).origin).href);
            if (c.text) emails = extractEmails(c.text, host);
          } catch (e) { /* ignore */ }
        }
        results[target] = { emails: emails };
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
    const hit = Object.keys(results).filter(function (u) { return results[u].emails && results[u].emails.length; }).length;
    context.res = json(200, { ok: true, count: urls.length, withEmail: hit, results: results });
  } catch (err) {
    context.log.error("scrape-contacts error:", err);
    context.res = json(500, { error: (err && err.message) || "scrape-contacts error" });
  }
};
