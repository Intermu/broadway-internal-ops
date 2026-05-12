# Data-store refactor — rollout & verification

This change introduces client-namespaced storage without breaking existing frontends.

## What changed

`api/data-store/index.js` now accepts a `client` query param. When present, it routes
reads/writes to `clients/{client}/{slot}` blobs. When absent, it falls through to the
old flat key behavior — so the existing HTMLs keep working until you update them.

Slots (same set for every client):
- `revenue`
- `wo-snapshot-today`
- `wo-snapshot-previous`
- `workbook`

Currently allowlisted clients: `pilot`. Edit `VALID_CLIENTS` in the function to add more.

## Rollout order

1. Deploy this version of `api/data-store/index.js` to dev SWA. Frontends still work because legacy path is preserved.
2. Run the migration script (next section) against dev storage to copy flat blobs into `clients/pilot/*`.
3. Run the verification curls below against dev. Both legacy and new paths should return the same data.
4. When all four HTMLs have been updated to send `?client=pilot`, watch App Insights for any requests still hitting the legacy path. Once it's been zero for a day, delete the `LEGACY_KEYS` block from the function and the flat blobs from storage.
5. Repeat for uat → prod.

## Running the migration

```bash
# Get the dev storage connection string
RG="rg-broadway-internal-apps-dev"
STORAGE_ACCT="<your dev storage account>"
export AZURE_STORAGE_CONNECTION_STRING=$(az storage account show-connection-string \
  --name "$STORAGE_ACCT" --resource-group "$RG" --query connectionString -o tsv)

# Dry run first to see what will happen
DRY_RUN=1 node scripts/migrate-flat-to-client-namespaced.js

# Then for real
node scripts/migrate-flat-to-client-namespaced.js
```

The script is idempotent: re-running it is safe. It skips blobs that already exist at
the destination with matching size, copies missing ones, and reports anything weird
(destination exists but different size) before overwriting.

## Verification curls

Replace `<SWA>` with your dev SWA hostname. You'll need to be authenticated through
Entra ID first — easiest is to open the site in your browser, log in, then grab the
`StaticWebAppsAuthCookie` cookie value from devtools and pass it as `-b "StaticWebAppsAuthCookie=..."`.
Or run these from inside the SWA via the browser console with `fetch()` instead.

```bash
SWA="https://<your-dev-swa-hostname>"
COOKIE="StaticWebAppsAuthCookie=<paste from devtools>"

# 1. Legacy path still works (existing HTMLs depend on this until they're updated)
curl -s -b "$COOKIE" "$SWA/api/data-store?key=pilot-revenue" | jq '.exists, .metadata.savedAt'

# 2. New path returns the same data
curl -s -b "$COOKIE" "$SWA/api/data-store?client=pilot&key=revenue" | jq '.exists, .metadata.savedAt'

# 3. List for a client
curl -s -b "$COOKIE" "$SWA/api/data-store?action=list&client=pilot" | jq

# 4. Legacy list still works
curl -s -b "$COOKIE" "$SWA/api/data-store?action=list" | jq

# 5. Allowlist enforcement — these should all 400
curl -s -b "$COOKIE" "$SWA/api/data-store?client=wendys&key=revenue" | jq      # unknown client
curl -s -b "$COOKIE" "$SWA/api/data-store?client=pilot&key=garbage" | jq       # unknown slot
curl -s -b "$COOKIE" "$SWA/api/data-store?client=pilot&key=pilot-revenue" | jq # legacy key with modern client param
```

Expected: 1 and 2 return identical `exists` and `savedAt`. 3 and 4 return roughly equivalent
(3 keyed by slot names, 4 keyed by legacy flat names). All three in section 5 return 400 with
an explanatory error message.

## When you add a second client

After all the frontend work is done and you're ready to onboard, say, Primark:

1. Add `"primark"` to `VALID_CLIENTS` in `api/data-store/index.js`.
2. Deploy.
3. Have Dominique upload a Primark revenue file through the agent — it lands at `clients/primark/revenue` automatically.

No migration needed for new clients; the blob path is created on first write.
