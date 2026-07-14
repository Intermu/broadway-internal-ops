// Azure Static Web Apps custom-roles function (rolesSource: "/api/get-roles").
//
// SWA calls this after login with the authenticated user's claims. We read the
// single assigned Entra app role, then return:
//   - broadway_employee  (the existing site-wide base gate; ALWAYS returned for a
//     signed-in user so route/api gating on broadway_employee is never stripped)
//   - the CUMULATIVE ops set: the user's level and every level below it
//
// Route gating then only ever names the minimum ops role - anyone at or above
// clears it automatically (a VP's set includes ops_manager, ops_supervisor, etc.).
//
// IMPORTANT:
//   - The Entra app-role "Value" field must equal these exact slugs.
//   - Users must sign out / in once after a role is assigned for the new claim
//     to appear in their token.
//   - If get-roles ever fails to run, SWA falls back to no custom roles, which
//     would drop broadway_employee and lock the site. Keep this function simple
//     and dependency-free so it cannot throw.

module.exports = async function (context, req) {
  // Lowest privilege first. Index 0 = Operations Coordinator, 5 = VP of Operations.
  var LEVELS = [
    'ops_coordinator',
    'lead_ops_coordinator',
    'ops_supervisor',
    'ops_manager',
    'dir_ops',
    'vp_ops'
  ];

  var roles = [];

  try {
    var claims = (req && req.body && req.body.claims) || [];
    var maxIdx = -1;

    // Entra surfaces app roles in the "roles" claim. Scan every claim value and
    // match against our known slugs so we don't depend on the exact claim "typ"
    // string (it varies: "roles" vs the full schema URI).
    claims.forEach(function (c) {
      var v = (c && c.val ? String(c.val) : '').trim();
      var i = LEVELS.indexOf(v);
      if (i > maxIdx) maxIdx = i;
    });

    // Base gate: any authenticated user who reaches this function is a Broadway
    // employee. Preserve the existing site-wide role.
    roles.push('broadway_employee');

    // Expand to the highest assigned ops level and everything below it.
    if (maxIdx >= 0) roles = roles.concat(LEVELS.slice(0, maxIdx + 1));
  } catch (e) {
    // Never throw: at minimum return the base gate so the site stays reachable.
    roles = ['broadway_employee'];
  }

  context.res = {
    headers: { 'Content-Type': 'application/json' },
    body: { roles: roles }
  };
};
