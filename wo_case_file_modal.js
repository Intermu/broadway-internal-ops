/* ============================================================================
 * BWN WO Case File — additive companion module for the Unified Ops Dashboard.
 * Loaded via <script src="wo_case_file_modal.js"> at the end of <body>.
 *
 * ZERO-REGRESSION BY DESIGN:
 *   - It only WRAPS the global openJobModal (additive) and OBSERVES #jobModalBox.
 *   - It never modifies the dashboard's existing markup, styles, or functions.
 *   - Every hook is wrapped in try/catch and fails to a no-op, so a failure here
 *     can never break the job modal or the rest of the dashboard.
 *
 * STYLING: uses the dashboard's own CSS variables (--color-surface,
 *   --color-surface-alt, --border, --text, --muted, --green, --green-dk) and
 *   mirrors the modal's .jn-doc-card / .jm-section-label look so the section
 *   reads as native chrome rather than a bolted-on panel. The section sits
 *   below .job-modal-body as a padded, bounded-scroll panel with the capture
 *   box pinned at the bottom.
 *
 * DATA: clients/pilot/wo-audit slot via /api/data-store (read-modify-write).
 *   { v:1, items:{ "<tracking>": { tracking, wo, title, sub, base:{text,ts}|null, updates:[{text,ts,win}] } } }
 *   WO Audit notes set .base; Recent Update notes append to .updates[].
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__bwncfLoaded) return;
  window.__bwncfLoaded = true;

  var API = '/api/data-store', CLIENT = 'pilot', SLOT = 'wo-audit';
  var STORE = { v: 1, items: {} };
  var loaded = false, loadingPromise = null, lastIds = [];

  // ---------- styles (namespaced bwncf-, built on the dashboard's variables) ----------
  function injectCss() {
    if (document.getElementById('bwncf-style')) return;
    var st = document.createElement('style'); st.id = 'bwncf-style';
    st.textContent = [
      // section chrome
      ".bwncf-sec{border-top:1px solid var(--border);padding:12px 18px 14px;background:var(--color-surface);font-family:'DM Sans',system-ui,sans-serif;flex:0 0 auto;display:flex;flex-direction:column;min-height:0;max-height:40vh;}",
      ".bwncf-sec-h{display:flex;align-items:center;gap:10px;margin:0 0 9px;flex:0 0 auto;}",
      ".bwncf-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:700;}",
      ".bwncf-pill{margin-left:auto;font:700 9px 'DM Mono',monospace;letter-spacing:.4px;text-transform:uppercase;color:var(--green-dk,#0d3d26);background:rgba(46,204,113,.14);border:1px solid rgba(46,204,113,.4);border-radius:999px;padding:3px 9px;}",
      ".bwncf-pill.warn{color:#8a5a14;background:#fff7ec;border-color:#f2dcbd;}",
      ".bwncf-pill.new{color:#fff;background:var(--green);border-color:var(--green);}",
      ".bwncf-scroll{flex:1 1 auto;overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:10px;}",
      // cards (mirror .jn-doc-card)
      ".bwncf-card{background:var(--color-surface-alt,#f8fafc);border:1px solid var(--border);border-radius:8px;overflow:hidden;}",
      ".bwncf-meta{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border);font:700 10px 'DM Mono',monospace;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;}",
      ".bwncf-meta .bwncf-dot{width:6px;height:6px;border-radius:50%;background:var(--green);flex:0 0 auto;}",
      ".bwncf-meta .bwncf-age{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:600;color:#9aa7b3;}",
      // rendered note body
      ".bwncf-doc{padding:11px 13px;color:var(--text);font:13px/1.55 'DM Sans',system-ui,sans-serif;}",
      ".bwncf-doc>:first-child{margin-top:0;}.bwncf-doc>:last-child{margin-bottom:0;}",
      ".bwncf-doc p{margin:0 0 8px;}.bwncf-doc strong{font-weight:700;color:var(--green-dk,#0d3d26);}",
      ".bwncf-title{font:800 14px/1.25 'DM Sans',sans-serif;color:var(--text);margin:0 0 3px;}",
      ".bwncf-sub{font:600 10px 'DM Mono',monospace;color:var(--muted);margin:0 0 10px;}",
      ".bwncf-h{display:flex;align-items:center;gap:8px;margin:14px 0 7px;font:700 10px 'DM Mono',monospace;color:var(--green-dk,#0d3d26);text-transform:uppercase;letter-spacing:.1em;}",
      ".bwncf-h::after{content:'';flex:1;height:1px;background:var(--border);}",
      ".bwncf-doc>.bwncf-h:first-child,.bwncf-doc>.bwncf-title:first-child{margin-top:0;}",
      ".bwncf-status{background:rgba(46,204,113,.08);border:1px solid rgba(46,204,113,.28);border-left:3px solid var(--green);border-radius:7px;padding:9px 12px;margin:0 0 6px;font-size:12.5px;line-height:1.5;color:var(--text);}",
      ".bwncf-flag{display:grid;grid-template-columns:22px 1fr;gap:9px;align-items:start;margin:6px 0;padding:8px 11px;background:#fff8ee;border:1px solid #f0ddbe;border-left:3px solid #e08a1e;border-radius:7px;font-size:12.5px;line-height:1.45;color:#5a4012;}",
      ".bwncf-flag .bwncf-fn{font:700 9px 'DM Mono',monospace;color:#b9740f;background:#fbeacb;border-radius:5px;width:22px;height:18px;display:flex;align-items:center;justify-content:center;}",
      ".bwncf-flag.hot{background:#fdece9;border-color:#f1cabf;border-left-color:#c0392b;color:#6e2018;}",
      ".bwncf-flag.hot .bwncf-fn{color:#fff;background:#c0392b;}",
      ".bwncf-vend{margin:6px 0;padding:8px 11px;background:var(--color-surface,#fff);border:1px solid var(--border);border-radius:7px;font-size:12.5px;line-height:1.45;color:var(--text);}",
      ".bwncf-vend strong{color:var(--green-dk,#0d3d26);}",
      ".bwncf-tl{display:flex;flex-direction:column;margin:6px 0 10px;border:1px solid var(--border);border-radius:8px;overflow:hidden;}",
      ".bwncf-tlrow{display:grid;grid-template-columns:70px 1fr;gap:11px;padding:6px 11px;border-bottom:1px solid var(--border);font-size:12.5px;line-height:1.4;}",
      ".bwncf-tlrow:last-child{border-bottom:none;}.bwncf-tlrow:nth-child(even){background:rgba(0,0,0,.015);}",
      ".bwncf-tldate{font:700 10px 'DM Mono',monospace;color:var(--green-dk,#0d3d26);white-space:nowrap;padding-top:1px;}",
      ".bwncf-tltext{color:var(--text);min-width:0;}",
      ".bwncf-tlrow.hot{background:#fdece9;}.bwncf-tlrow.hot .bwncf-tldate{color:#c0392b;}",
      ".bwncf-ol{margin:5px 0 10px;padding-left:0;list-style:none;counter-reset:bwncf;}",
      ".bwncf-ol li{position:relative;counter-increment:bwncf;padding:4px 0 4px 28px;line-height:1.45;border-bottom:1px solid var(--border);font-size:12.5px;}",
      ".bwncf-ol li:last-child{border-bottom:none;}",
      ".bwncf-ol li::before{content:counter(bwncf);position:absolute;left:0;top:4px;width:19px;height:19px;border-radius:6px;background:rgba(46,204,113,.14);color:var(--green-dk,#0d3d26);font:700 9px 'DM Mono',monospace;display:flex;align-items:center;justify-content:center;}",
      ".bwncf-empty{color:var(--muted);font-size:12.5px;line-height:1.5;padding:1px 2px 2px;}",
      // capture (pinned below the scroll)
      ".bwncf-cap{flex:0 0 auto;margin-top:10px;background:var(--color-surface-alt,#f8fafc);border:1px solid var(--border);border-radius:8px;padding:10px 12px;}",
      ".bwncf-cap textarea{width:100%;box-sizing:border-box;min-height:54px;border:1px solid var(--border);border-radius:7px;padding:8px 10px;font:12px/1.5 'DM Mono',monospace;color:var(--text);background:var(--color-surface,#fff);resize:vertical;outline:none;}",
      ".bwncf-cap textarea:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(46,204,113,.16);}",
      ".bwncf-caprow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;}",
      ".bwncf-info{flex:1;min-width:140px;font:600 10px 'DM Mono',monospace;color:var(--muted);}",
      ".bwncf-seg{display:inline-flex;background:var(--color-surface,#fff);border:1px solid var(--border);border-radius:7px;padding:2px;gap:2px;}",
      ".bwncf-seg button{border:none;background:transparent;padding:5px 10px;border-radius:5px;font:600 10px 'DM Mono',monospace;color:var(--muted);cursor:pointer;}",
      ".bwncf-seg button.on{background:rgba(46,204,113,.14);color:var(--green-dk,#0d3d26);}",
      ".bwncf-btn{padding:6px 14px;border:none;border-radius:7px;cursor:pointer;font:700 11px 'DM Sans',sans-serif;}",
      ".bwncf-btn.p{color:#fff;background:var(--green);}",
      ".bwncf-btn.p:disabled{opacity:.4;cursor:default;}",
      ".bwncf-msg{font:600 10px 'DM Mono',monospace;margin-top:6px;min-height:12px;}",
      ".bwncf-msg.ok{color:var(--green-dk,#0d3d26);}.bwncf-msg.err{color:#c0392b;}.bwncf-msg.mut{color:var(--muted);}"
    ].join('\n');
    document.head.appendChild(st);
  }

  // ---------- data store I/O ----------
  function loadStore(force) {
    if (loaded && !force) return Promise.resolve(STORE);
    if (loadingPromise && !force) return loadingPromise;
    loadingPromise = fetch(API + '?key=' + SLOT + '&client=' + CLIENT, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        STORE = (j && j.exists && j.data && j.data.items) ? j.data : { v: 1, items: {} };
        STORE.items = STORE.items || {}; loaded = true; loadingPromise = null; return STORE;
      })
      .catch(function (e) { loadingPromise = null; throw e; });
    return loadingPromise;
  }
  function saveStore() {
    var n = Object.keys(STORE.items).length;
    return fetch(API + '?key=' + SLOT + '&client=' + CLIENT, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: STORE, metadata: { count: String(n) } })
    }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (b) { throw new Error('HTTP ' + r.status + ' ' + (b.error || '')); });
      return r.json();
    });
  }

  // ---------- note parsing / save ----------
  function parseNote(text) {
    var norm = String(text || '').replace(/\r/g, '');
    var nonEmpty = norm.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    var l1 = nonEmpty[0] || '';
    var l2 = (nonEmpty[1] && nonEmpty[1].indexOf('|') >= 0) ? nonEmpty[1] : '';
    var trkM = norm.match(/TRACKING\s*#?\s*([0-9]{5,})/i);
    var woM = norm.match(/\bWO\s+([A-Za-z]?-?\d[\w-]*)/);
    var winM = norm.match(/last\s+(\d+)\s+days/i);
    return {
      tracking: trkM ? trkM[1] : '',
      wo: woM ? woM[1] : '',
      title: l1, sub: l2,
      isUpdate: /RECENT ACTIVITY/i.test(norm),
      win: winM ? parseInt(winM[1], 10) : 7,
      text: norm.trim()
    };
  }
  function saveParsedNote(parsed, kind, fallbackKey) {
    var key = parsed.tracking || parsed.wo || fallbackKey;
    if (!key) throw new Error('No TRACKING # or WO number found in the note.');
    var rec = STORE.items[key] || { tracking: parsed.tracking, wo: parsed.wo, title: parsed.title, sub: parsed.sub, base: null, updates: [] };
    if (parsed.wo) rec.wo = parsed.wo;
    if (parsed.tracking) rec.tracking = parsed.tracking;
    if (parsed.title) rec.title = parsed.title;
    if (parsed.sub) rec.sub = parsed.sub;
    if (kind === 'base') { rec.base = { text: parsed.text, ts: Date.now() }; }
    else { rec.updates = rec.updates || []; rec.updates.push({ text: parsed.text, ts: Date.now(), win: parsed.win }); if (rec.updates.length > 25) rec.updates = rec.updates.slice(-25); }
    STORE.items[key] = rec;
    return key;
  }

  // ---------- helpers ----------
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function fmtDate(ts) { var x = new Date(ts); return (x.getMonth() + 1) + '/' + x.getDate() + '/' + x.getFullYear(); }
  function fmtRel(ts) { var d = Math.floor((Date.now() - ts) / 86400000); return d <= 0 ? 'today' : (d === 1 ? 'yesterday' : d + ' days ago'); }
  function updatesSince(rec) { var since = rec && rec.base ? rec.base.ts : 0; return ((rec && rec.updates) || []).filter(function (u) { return u.ts > since; }).length; }
  function digitsOnly(s) { return String(s || '').replace(/[^0-9]/g, ''); }
  function findRecord(ids) {
    var blob = ids.join(' '); var keys = Object.keys(STORE.items);
    var nums = blob.match(/\d{7,9}/g) || [];
    for (var i = 0; i < nums.length; i++) { if (STORE.items[nums[i]]) return STORE.items[nums[i]]; }
    for (var k = 0; k < keys.length; k++) { if (STORE.items[keys[k]].tracking && nums.indexOf(STORE.items[keys[k]].tracking) !== -1) return STORE.items[keys[k]]; }
    var woDig = (blob.match(/W-?\d{3,}/gi) || []).map(digitsOnly);
    for (var k2 = 0; k2 < keys.length; k2++) { var rc = STORE.items[keys[k2]]; if (rc.wo && woDig.indexOf(digitsOnly(rc.wo)) !== -1) return rc; }
    return null;
  }
  function identityFor(ids) {
    var blob = ids.join(' ');
    return { tracking: (blob.match(/\b\d{7,9}\b/) || [])[0] || '', wo: (blob.match(/W-?\d{3,}/i) || [])[0] || '' };
  }

  // ---------- case-file renderer (mirrors the userscript / standalone tool) ----------
  function mdInline(parent, text) {
    var re = /\*\*([^*]+)\*\*/g, last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var b = document.createElement('strong'); b.textContent = m[1]; parent.appendChild(b);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function renderCaseFile(container, src) {
    container.textContent = '';
    var lines = String(src || '').split(/\r?\n/);
    var first = true, section = 'other', tl = null, ol = null, flagN = 0;
    var HOT = /\b(escalat|overdue|unpaid|halt|urgent|immediately|lien|stop work|dispute|rejected|cancel|backup vendor)\b/i;
    function flushTl() { if (tl) { container.appendChild(tl); tl = null; } }
    function flushOl() { if (ol) { container.appendChild(ol); ol = null; } }
    function flushAll() { flushTl(); flushOl(); }
    function addP(t, cls) { var p = document.createElement('p'); if (cls) p.className = cls; mdInline(p, t); container.appendChild(p); }
    function heading(t) { flushAll(); var h = document.createElement('div'); h.className = 'bwncf-h'; h.textContent = t.trim(); container.appendChild(h); }
    function sectionOf(L) { L = L.toUpperCase(); if (/RISK FLAG/.test(L)) return 'flags'; if (/VENDOR|SUPPLIER/.test(L)) return 'vendors'; if (/TIMELINE|RECENT ACTIVITY/.test(L)) return 'timeline'; if (/NEXT ACTION|NEXT STEP/.test(L)) return 'actions'; if (/STATUS/.test(L)) return 'status'; return 'other'; }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) { flushAll(); continue; }
      if (first) { first = false; flushAll(); var ti = document.createElement('div'); ti.className = 'bwncf-title'; ti.textContent = t; container.appendChild(ti); continue; }
      if (t.indexOf('|') >= 0) { flushAll(); addP(t, 'bwncf-sub'); continue; }
      var ci = t.indexOf(':');
      if (ci > 0) {
        var lab = t.slice(0, ci);
        if (lab === lab.toUpperCase() && /[A-Z]/.test(lab) && lab.length <= 46) {
          heading(lab); section = sectionOf(lab); flagN = 0;
          var rest = t.slice(ci + 1).trim();
          if (rest) {
            if (section === 'status') { var sb = document.createElement('div'); sb.className = 'bwncf-status'; mdInline(sb, rest); container.appendChild(sb); }
            else if (section === 'flags') { t = 'FLAG: ' + rest; }
            else addP(rest);
          }
          if (section !== 'flags') continue;
        }
      }
      if (section === 'flags') { flushAll(); var fx = t.replace(/^FLAG[:\-\s]*/i, ''); flagN++; var card = document.createElement('div'); card.className = 'bwncf-flag' + (HOT.test(fx) ? ' hot' : ''); var n = document.createElement('span'); n.className = 'bwncf-fn'; n.textContent = flagN; var bd = document.createElement('span'); mdInline(bd, fx); card.appendChild(n); card.appendChild(bd); container.appendChild(card); continue; }
      if (section === 'vendors') { flushAll(); var vc = document.createElement('div'); vc.className = 'bwncf-vend'; mdInline(vc, t); container.appendChild(vc); continue; }
      var dm = t.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*[\u2014\-]\s*(.*)$/);
      if (dm) { flushOl(); if (!tl) { tl = document.createElement('div'); tl.className = 'bwncf-tl'; } var row = document.createElement('div'); row.className = 'bwncf-tlrow' + (HOT.test(dm[2]) ? ' hot' : ''); var ds = document.createElement('span'); ds.className = 'bwncf-tldate'; ds.textContent = dm[1]; var tx = document.createElement('span'); tx.className = 'bwncf-tltext'; mdInline(tx, dm[2]); row.appendChild(ds); row.appendChild(tx); tl.appendChild(row); continue; }
      flushTl();
      var nm = t.match(/^(\d+)[.)]\s+(.*)$/);
      if (nm) { if (!ol) { ol = document.createElement('ol'); ol.className = 'bwncf-ol'; } var li = document.createElement('li'); mdInline(li, nm[2]); ol.appendChild(li); continue; }
      flushOl();
      addP(t);
    }
    flushAll();
  }

  // ---------- capture box (paste a note for this job) ----------
  function captureBox(identity, onSaved) {
    var wrap = el('div', 'bwncf-cap');
    var ta = el('textarea'); ta.placeholder = 'Paste a WO Audit or Recent Update note for this job, then Save\u2026';
    var row = el('div', 'bwncf-caprow');
    var info = el('div', 'bwncf-info', 'Paste a note to file it.');
    var seg = el('div', 'bwncf-seg');
    var bBase = el('button', null, 'Full Audit'); bBase.type = 'button'; bBase.setAttribute('data-k', 'base');
    var bUp = el('button', null, 'Recent Update'); bUp.type = 'button'; bUp.setAttribute('data-k', 'update');
    seg.appendChild(bBase); seg.appendChild(bUp);
    var save = el('button', 'bwncf-btn p', 'Save'); save.type = 'button'; save.disabled = true;
    row.appendChild(info); row.appendChild(seg); row.appendChild(save);
    var msg = el('div', 'bwncf-msg', '');
    wrap.appendChild(ta); wrap.appendChild(row); wrap.appendChild(msg);

    var kind = 'base', parsed = null;
    function setKind(k) { kind = k; bBase.className = (k === 'base' ? 'on' : ''); bUp.className = (k === 'update' ? 'on' : ''); }
    setKind('base');
    function refresh() {
      var t = ta.value.trim();
      if (!t) { parsed = null; info.textContent = 'Paste a note to file it.'; save.disabled = true; return; }
      parsed = parseNote(t); setKind(parsed.isUpdate ? 'update' : 'base');
      var who = parsed.tracking ? ('#' + parsed.tracking) : (parsed.wo || (identity.tracking || identity.wo || 'this job'));
      info.textContent = 'Detected ' + who + ' \u00b7 ' + (parsed.isUpdate ? 'Recent Update' : 'Full Audit');
      save.disabled = false;
    }
    ta.addEventListener('input', refresh);
    seg.addEventListener('click', function (e) { var k = e.target.getAttribute('data-k'); if (k) setKind(k); });
    save.addEventListener('click', function () {
      if (!parsed) return;
      save.disabled = true; msg.className = 'bwncf-msg mut'; msg.textContent = 'Saving\u2026';
      var key;
      try { key = saveParsedNote(parsed, kind, identity.tracking || identity.wo); }
      catch (e) { msg.className = 'bwncf-msg err'; msg.textContent = e.message || String(e); save.disabled = false; return; }
      saveStore().then(function () { msg.className = 'bwncf-msg ok'; msg.textContent = 'Saved.'; ta.value = ''; parsed = null; if (onSaved) onSaved(key); })
        .catch(function (err) { msg.className = 'bwncf-msg err'; msg.textContent = String(err.message || err); save.disabled = false; loadStore(true).catch(function () {}); });
    });
    return wrap;
  }

  // ---------- build the section ----------
  function cardEl(metaLabel, age, text) {
    var c = el('div', 'bwncf-card');
    var m = el('div', 'bwncf-meta');
    m.appendChild(el('span', 'bwncf-dot'));
    m.appendChild(el('span', null, metaLabel));
    m.appendChild(el('span', 'bwncf-age', age));
    c.appendChild(m);
    var d = el('div', 'bwncf-doc'); renderCaseFile(d, text); c.appendChild(d);
    return c;
  }
  function setPill(pill, rec) {
    var us = updatesSince(rec);
    if (!rec) { pill.className = 'bwncf-pill warn'; pill.textContent = 'None on file'; }
    else if (us) { pill.className = 'bwncf-pill new'; pill.textContent = us + ' new'; }
    else { pill.className = 'bwncf-pill'; pill.textContent = rec.base ? 'On file' : 'Updates only'; }
  }
  function buildSection(box) {
    var ids = lastIds.slice(); ids.push(box.textContent || '');
    var rec = findRecord(ids);
    var identity = identityFor(ids);
    var sec = el('div', 'bwncf-sec'); sec.id = 'bwncf-sec';
    var h = el('div', 'bwncf-sec-h');
    h.appendChild(el('span', 'bwncf-label', 'WO Case File'));
    var pill = el('span', 'bwncf-pill'); h.appendChild(pill);
    setPill(pill, rec);
    sec.appendChild(h);
    var scroll = el('div', 'bwncf-scroll'); sec.appendChild(scroll);
    if (rec && rec.base) scroll.appendChild(cardEl('Full Audit', 'captured ' + fmtDate(rec.base.ts), rec.base.text));
    var ups = rec ? (rec.updates || []).slice().sort(function (a, b) { return b.ts - a.ts; }) : [];
    ups.forEach(function (u) { scroll.appendChild(cardEl('Recent Update \u00b7 last ' + (u.win || 7) + ' days', fmtDate(u.ts) + ' \u00b7 ' + fmtRel(u.ts), u.text)); });
    if (!rec || (!rec.base && !ups.length)) scroll.appendChild(el('div', 'bwncf-empty', 'No audit or updates saved for this WO yet \u2014 paste one below to start the case file.'));
    sec.appendChild(captureBox(identity, function () { var ex = box.querySelector('#bwncf-sec'); if (ex) ex.remove(); injectPanel(); }));
    return sec;
  }

  // ---------- job-modal hook ----------
  function modalOpen(ov) { return ov && (ov.classList.contains('open') || ov.offsetParent !== null || getComputedStyle(ov).display !== 'none'); }
  function injectPanel() {
    var box = document.getElementById('jobModalBox');
    var ov = document.getElementById('jobModalOverlay');
    if (!box || !ov || !modalOpen(ov)) return;
    if (box.querySelector('#bwncf-sec')) return;     // already injected for this open
    injectCss();
    loadStore().then(function () { paint(box); }).catch(function () { paint(box); });   // paint either way; empty store on failure
    function paint(b) { if (b.querySelector('#bwncf-sec')) return; try { b.appendChild(buildSection(b)); } catch (e) { /* never break the modal */ } }
  }

  function start() {
    // 1) wrap openJobModal additively to capture the job identity argument(s)
    try {
      if (typeof window.openJobModal === 'function' && !window.openJobModal.__bwncf) {
        var orig = window.openJobModal;
        var wrapped = function () {
          try { lastIds = []; for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; if (a == null) continue; lastIds.push(typeof a === 'object' ? (function () { try { return JSON.stringify(a); } catch (e) { return ''; } })() : String(a)); } } catch (e) {}
          var r; try { r = orig.apply(this, arguments); } finally { setTimeout(injectPanel, 0); setTimeout(injectPanel, 180); }
          return r;
        };
        wrapped.__bwncf = true;
        window.openJobModal = wrapped;
      }
    } catch (e) {}
    // 2) observer fallback: keep the section present while the modal is open,
    //    and handle opens that don't route through openJobModal
    try {
      var box = document.getElementById('jobModalBox');
      if (box) {
        var mo = new MutationObserver(function () { injectPanel(); });
        mo.observe(box, { childList: true });
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
