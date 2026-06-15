// auth.js - Broadway internal ops shared auth helper (sibling to client.js).
//
// Reads the SWA-injected principal from /.auth/me and exposes the user's role
// LEVEL (1-6) derived from the cumulative roles that /api/get-roles returns.
//
// NOTE: everything here is COSMETIC - it decides what the UI shows. Real access
// control is enforced by route gating (staticwebapp.config.json) and by
// server-side role checks in the data Functions. Never rely on this alone to
// protect sensitive data.

(function (global) {
  var LEVELS = ['ops_coordinator', 'lead_ops_coordinator', 'ops_supervisor', 'ops_manager', 'dir_ops', 'vp_ops'];
  var LABELS = {
    ops_coordinator: 'Operations Coordinator',
    lead_ops_coordinator: 'Lead Operations Coordinator',
    ops_supervisor: 'Operations Supervisor',
    ops_manager: 'Operations Manager',
    dir_ops: 'Director of Operations',
    vp_ops: 'Vice President of Operations'
  };

  var _principal = null, _loaded = false;

  async function getPrincipal() {
    if (_loaded) return _principal;
    try {
      var r = await fetch('/.auth/me', { credentials: 'same-origin' });
      var d = await r.json();
      _principal = (d && d.clientPrincipal) || null;
    } catch (e) { _principal = null; }
    _loaded = true;
    return _principal;
  }

  function levelOf(p) {
    var roles = (p && p.userRoles) || [], max = 0;
    LEVELS.forEach(function (slug, i) { if (roles.indexOf(slug) !== -1) max = Math.max(max, i + 1); });
    return max; // 0 = no ops role assigned; 1-6 otherwise
  }

  async function roleLevel() { return levelOf(await getPrincipal()); }
  async function hasLevel(min) { return (await roleLevel()) >= min; }
  async function roleLabel() { var l = await roleLevel(); return l ? LABELS[LEVELS[l - 1]] : 'No role assigned'; }
  async function userName() { var p = await getPrincipal(); return p ? (p.userDetails || '') : ''; }

  // Per-user profile blob, keyed by Entra object ID. Uses the existing data-store
  // helper if present. Adapt the key/slot to your namespacing scheme.
  async function loadUserProfile() {
    var p = await getPrincipal();
    if (!p || !p.userId) return null;
    try {
      if (typeof global.bnDataGet === 'function') {
        var res = await global.bnDataGet('users/' + p.userId);
        return res && res.exists ? res.data : null;
      }
    } catch (e) { /* best-effort */ }
    return null;
  }

  // Cosmetic UI gating: hide any element marked data-bwn-min="<level>" that the
  // user's level doesn't meet. e.g. <a href="diagnostic.html" data-bwn-min="4">
  async function applyUiGates(root) {
    var lvl = await roleLevel();
    (root || document).querySelectorAll('[data-bwn-min]').forEach(function (el) {
      var min = parseInt(el.getAttribute('data-bwn-min'), 10);
      if (!isNaN(min) && lvl < min) el.style.display = 'none';
    });
  }

  global.BWNAuth = {
    getPrincipal: getPrincipal,
    roleLevel: roleLevel,
    hasLevel: hasLevel,
    roleLabel: roleLabel,
    userName: userName,
    loadUserProfile: loadUserProfile,
    applyUiGates: applyUiGates,
    LEVELS: LEVELS,
    LABELS: LABELS
  };
})(window);
