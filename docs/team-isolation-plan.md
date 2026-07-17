# Team Isolation - Design Plan (review before build)

Status: **Phase A BUILT** (2026-07-17) - `api/hvac-benchmark` + Bid-Out shared wiring, tested
26/26 (server) and staged/pushed. Awaiting from you: the team roster to seed + two app settings
(`ROSTER_ADMINS`, and confirm `AZURE_STORAGE_CONNECTION_STRING`/`WO_INGEST_KEY` are set - they
are, used by other functions). Phases B-D below remain PROPOSAL.

**Ownership model (confirmed 2026-07-17):** a team's OWNER is a Manager. Supervisors work UNDER a
Manager (so a Supervisor is a `member` of that Manager's team) EXCEPT a "Supervisor-run team",
where the Supervisor is the team OWNER. The roster's `owner` field therefore holds a Manager OR a
Supervisor; ordinary Supervisors are listed in `members`. Chosen start: **Phase A only** (shared
HVAC benchmark per team, no dashboard changes yet).

## Why

The suite is rolling out to all of Service, not just one team. Today every signed-in
`broadway_employee` reads and writes the SAME server data: all dashboard numbers live in one
org-wide bucket (`clients/pilot/<slot>`), and the login carries no team information at all
(only `broadway_employee` + the ops ladder + the user's email).

Requirement (verbatim intent): "Teams are separate and I wouldn't want another manager or
regular coordinators looking at my team's numbers, or my dashboard for a potential erroneous
change." So shared SWA data must be scoped so a person sees (and can change) only their own
team's data - while still letting a manager drop something once and have their whole team use
it.

Chosen identity source (your call): a **team roster kept in the SWA**. No IT / Entra work
needed to start; upgradeable to Entra security groups later without changing how data is
stored.

---

## 1. Team identity: the roster

A single small admin blob defines teams and membership. The server resolves a caller's team
from their AUTHENTICATED email - never from anything the client sends (a client-supplied team
id would be spoofable, which is the whole thing we are preventing).

### Roster schema (`teams/roster` blob, one JSON doc)

```json
{
  "v": 1,
  "teams": [
    { "id": "najarro",   "name": "Najarro",   "owner": "mnajarro@broadwaynational.com",
      "members": ["coord1@broadwaynational.com", "sup-under-mgr@broadwaynational.com"] },
    { "id": "diaz-super", "name": "Diaz (Supervisor-run)", "owner": "supervisor@broadwaynational.com",
      "members": ["coord3@broadwaynational.com"] }
  ],
  "oversight": { "dir_ops": "*", "vp_ops": "*" }
}
```

- `id` is the storage key segment (kebab, stable, never reused).
- `owner` = the team's Manager, OR a Supervisor for a Supervisor-run team.
- `members` = that team's coordinators, plus any Supervisors working under the Manager.
- A person belongs to the team whose `owner` or `members` contains their email (lowercased).
  (Phase A also accepts a legacy `manager` key as an alias for `owner`.)
- `oversight` maps a role level to the teams it may READ. `"*"` = all teams. Default:
  leadership (`dir_ops`, `vp_ops`) can read every team; everyone else only their own.

### Resolution

```
teamOf(email)      -> teamId | null      (from roster; null = not on any team)
readableTeams(req) -> [teamId, ...]      (own team, plus oversight teams by role level)
writableTeam(req)  -> teamId | null      (ALWAYS just the caller's own team)
```

- Two authenticated identities feed `email`:
  1. **AAD pages** (tracker / dashboard / agent / check-in / case-file): email from the
     `x-ms-client-principal` header (already parsed by `principalFromReq`).
  2. **Userscript writers** (the AI connector -> `wo-ingest`): NO AAD principal; they present
     `x-bwn-key` + the Umbrava Auth0 token. Team resolves from the Umbrava-token email
     (`api/user-role` already verifies that token and extracts the namespaced email claim).

### Fallback (safe default)

- `teamOf` returns null -> the caller has **no shared team scope**. They read/write only a
  private, per-user scope (`users/<emailhash>/<slot>`) and see nothing shared until an admin
  adds them to the roster. Fail-closed: an unrostered user never lands in someone else's data.

### Who maintains the roster

- Read: any signed-in employee (needed to resolve their own team) - but the response only ever
  reveals the caller's own team + (for leadership) the teams they oversee.
- Write: gated to leadership (`dir_ops` L5+) OR a dedicated `ops_admin` app role, via a small
  admin screen (or, to start, I seed the blob from a list you give me). A manager must not be
  able to edit another manager's roster row.

---

## 2. Data classification (what gets scoped, what does not)

| Data | Today | Proposed scope | Rationale |
|---|---|---|---|
| Dashboard numbers - `revenue`, `revenue-gp`, `over30-history`, `om-bonus`, `checkin`, `exception-queue`, `live-jobs`, `wo-snapshot-*`, `o30-lines`, `job-plans`, `job-notes`, `wo-audit`, `job-divisions`, `workbook`, `config` (16 slots) | `clients/pilot/<slot>` (org-wide) | **Per team**: `teams/<teamId>/<slot>` | These are "my team's numbers / my dashboard." The core of the request. |
| **HVAC PM benchmark** (new) | GM-local per user | **Per team**: `teams/<teamId>/hvac-benchmark` | Manager drops once; the team reuses. Target prices are competitive - not for other teams. |
| Vendor-prospect pipeline (`vendor-prospects/db`) | org-wide | **Stays org-wide** | Deliberate: it is a shared cost pool - a paid ZoomInfo/Places lookup by any team should save every team from paying again. It is leads, not "team numbers." (DNC / outcome history are org-wide too.) |
| Bid send audit + open tracking (`send-bid`, `track-open`) | org-wide | **Stays org-wide** | It is a global send-budget ceiling + idempotency ledger; splitting it per team would weaken the anti-double-send guarantee. No team numbers exposed. |
| W-9 / TIN / EIN (Vendor Intake) | 100% local, never persisted | **Unchanged - stays local** | Hard rule. Never enters this system. |

Open question for you: is `config` team-specific or org-wide? (If it holds per-team dashboard
prefs -> team. If it holds site-wide settings -> org-wide. Recommend: team.)

---

## 3. Key-scheme change

- Old: `clients/${client}/${slot}` with `VALID_CLIENTS = ["pilot"]`.
- New: `teams/${teamId}/${slot}` for team-scoped slots; `users/${emailHash}/${slot}` for the
  private fallback; org-wide blobs (vendor-prospects, send audit) keep their current keys.
- `resolveTarget()` in `data-store` stops taking a client from the query string and instead
  derives the team server-side from the caller (`writableTeam` for writes; the requested team
  must be in `readableTeams` for reads, else 403). No client-controlled prefix, ever.

---

## 4. Component-by-component changes

1. **`api/_lib` (new shared module)** - `parseRoster`, `teamOf`, `readableTeams`,
   `writableTeam`, `emailHash`. Pure `crypto`, no deps. One place so `data-store` and
   `wo-ingest` resolve teams identically.
2. **`api/data-store`** - swap the client param for server-side team derivation; read gate =
   requested team in `readableTeams`; write gate = target is `writableTeam`; keep the existing
   financial-slot L4+ gate (it now applies WITHIN a team). List action returns only readable
   teams' slots.
3. **`api/wo-ingest`** - resolve the writer's team from the Umbrava-token email and write under
   `teams/<teamId>/...` for `o30-lines` / `job-plans` / `wo-snapshot-*`. An unrostered writer
   -> reject with a clear message (its data would otherwise be homeless) OR write to private -
   recommend reject, since these feed a shared dashboard.
4. **`api/hvac-benchmark` (new)** - GET/PUT the team's benchmark index. Same dual auth as
   `vendor-prospects` (AAD principal OR shared key + Umbrava token). Body is the parsed index
   JSON the Bid-Out userscript already builds (`hvacBuildIndex` output). Team derived
   server-side.
5. **Bid-Out userscript** - after `hvacParseAndStore`, PUT the index to `api/hvac-benchmark`
   (shared) instead of only `GM_setValue`; on load, GET the team index first, fall back to
   GM-local if offline. Drop-once-per-team. (Userscript = I push; version bump.)
6. **The 5 AAD HTML readers** - `agent.html`, `Broadway_Coordinator_CheckIn.html`,
   `Broadway_Unified_Ops_Dashboard.html`, `Pilot_Proposal_Diagnostic.html`, `wo_case_file.html`
   - drop `client=pilot` from their `/api/data-store` calls (team is implicit now). If a page
   should let leadership pick which team to view, add a team selector fed by `readableTeams`.
7. **`get-roles`** - unchanged for now (roster is separate). Optional later: add an `ops_admin`
   role for roster editing.

---

## 5. Access-control matrix

| Actor | Read | Write |
|---|---|---|
| Coordinator / lead / supervisor / manager | Own team only | Own team only |
| `dir_ops` / `vp_ops` (leadership) | All teams (oversight) | **Own team only** (read-all, write-own) |
| Unrostered employee | Private scope only | Private scope only |
| Userscript writer (`wo-ingest`) | n/a | Own team (from Umbrava email); reject if unrostered |

- "Read-all, write-own" for leadership directly answers the "erroneous change" worry: even a
  director cannot overwrite a team's numbers - only view them.
- Financial slot (`revenue-gp`) keeps its L4+ gate, now evaluated within the team scope.

Resolved (2026-07-17): Supervisors do NOT span multiple teams. A Supervisor is a `member` under
one Manager, unless they run their own team (then they are that team's `owner`). So one person =
one team; no `supervises: []` fan-out needed for Phase A. (Revisit only if a supervisor later
needs to aggregate several managers' teams - a Phase B/C oversight concern, not Phase A.)

---

## 6. Migration of existing data

Existing `clients/pilot/<slot>` blobs hold real, in-use dashboard data. Options:
- **A (recommended):** one-time copy of each `pilot` slot into the correct team prefix using a
  short, reviewed migration script (run once by you). Requires knowing which existing rows
  belong to which team - the `o30-lines` / `job-plans` / snapshots carry the assigned
  coordinator, so they can be split by roster membership; `revenue` / `over30-history` may need
  a manual team tag.
- **B:** freeze `pilot` as a read-only "legacy/all" team that only leadership can see, and let
  teams accrue fresh data going forward. Less accurate history per team, zero migration risk.

Recommend A for the row-level slots (they carry a coordinator) and B's fallback for any
aggregate slot that cannot be split cleanly.

---

## 7. Phasing (each phase is independently shippable + reviewable)

- **Phase A - Identity + benchmark (low risk):** `_lib` resolver + roster blob (seeded from
  your list) + `api/hvac-benchmark` + Bid-Out reads/writes it. No existing dashboard data
  touched. Proves the roster + team-scoping end to end.
- **Phase B - data-store re-key:** switch `data-store` to server-side team scope + the
  read/write matrix. Ship alongside the migration script. This is the big one.
- **Phase C - Writers + readers:** `wo-ingest` team-aware writes; the 5 HTML pages drop the
  client param and (for leadership) gain a team selector.
- **Phase D - Admin polish:** roster admin screen + optional `ops_admin` role, so you are not
  hand-editing the roster blob.

---

## 8. Open questions for you (blockers for Phase B, not Phase A)

1. **Team list + membership**: the actual teams and who is on each (manager + coordinator
   emails). I need this to seed the roster.
2. **Supervisor span**: does a supervisor own one team or several? (Drives `readableTeams`.)
3. **`config` slot**: team-specific or org-wide?
4. **History migration**: split existing `pilot` data into teams (Option A), or freeze it as a
   leadership-only legacy view (Option B)?
5. **Leadership write**: confirm read-all / write-own is the intended power for `dir_ops` /
   `vp_ops` (recommended), vs. full write across teams.

Deploy split unchanged: userscript changes I push to `Intermu/userscripts`; every SWA change
here (functions, HTML, this doc, the migration script) you push from `broadway-internal-ops`.
