# Broadway National Internal Ops Tools — Azure

Internal HTML-based ops tools, hosted on Azure Static Web Apps with Entra ID auth.

## Repo layout

```
.
├── *.html                        # Tool frontends (agent, index, Pilot_Proposal_Diagnostic, Broadway_Unified_Ops_Dashboard)
├── api/                          # Azure Functions (replaces Netlify Functions)
│   ├── generate/                 # Anthropic API proxy
│   ├── data-store/               # Blob-backed JSON KV store
│   ├── host.json
│   └── package.json
├── scripts/
│   └── migrate-from-netlify.js   # One-time data migration
├── staticwebapp.config.json      # Auth + routing
├── .github/workflows/            # CI/CD
└── package.json                  # Root (for migration script only)
```

## Deployment runbook

Run these once per environment (dev first, then uat/prod after smoke testing).

### 1. Provision Azure resources

Replace `<rg>` with the actual resource group IT created (e.g. `rg-broadway-internal-apps-dev`).

```bash
RG="<rg>"
LOCATION="eastus"
STORAGE_ACCT="bnopsdev$(openssl rand -hex 3)"   # must be globally unique, lowercase, 3-24 chars
KV_NAME="kv-bn-ops-dev-$(openssl rand -hex 2)"  # must be globally unique
SWA_NAME="swa-bn-ops-dev"

# Storage account (for the data-store blobs)
az storage account create \
  --name "$STORAGE_ACCT" \
  --resource-group "$RG" \
  --location "$LOCATION" \
  --sku Standard_LRS \
  --kind StorageV2

STORAGE_CONN=$(az storage account show-connection-string \
  --name "$STORAGE_ACCT" --resource-group "$RG" --query connectionString -o tsv)

# Key Vault
az keyvault create \
  --name "$KV_NAME" \
  --resource-group "$RG" \
  --location "$LOCATION"

az keyvault secret set --vault-name "$KV_NAME" --name "AnthropicApiKey" --value "<your-anthropic-key>"
az keyvault secret set --vault-name "$KV_NAME" --name "StorageConnectionString" --value "$STORAGE_CONN"

# Static Web App (do this via portal first time — easier to wire up GitHub auth)
# Or:
az staticwebapp create \
  --name "$SWA_NAME" \
  --resource-group "$RG" \
  --location "$LOCATION" \
  --sku Standard
```

### 2. Configure SWA app settings

In the Azure portal → your SWA → **Configuration** → add these app settings:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `@Microsoft.KeyVault(VaultName=<kv>;SecretName=AnthropicApiKey)` |
| `AZURE_STORAGE_CONNECTION_STRING` | `@Microsoft.KeyVault(VaultName=<kv>;SecretName=StorageConnectionString)` |
| `AAD_CLIENT_ID` | (from Entra app registration, see step 3) |
| `AAD_CLIENT_SECRET` | (from Entra app registration) |

Then grant the SWA's managed identity `Key Vault Secrets User` role on the vault.

### 3. Set up Entra ID auth

In Entra admin center:
1. **App registrations** → New registration → name it `Broadway Internal Ops`.
2. Redirect URI: `https://<swa-default-hostname>/.auth/login/aad/callback` (Web platform).
3. Note the **Application (client) ID** → that's `AAD_CLIENT_ID`.
4. **Certificates & secrets** → New client secret → that's `AAD_CLIENT_SECRET`.
5. **Token configuration** → Add groups claim (Security groups).
6. Edit `staticwebapp.config.json` and replace `REPLACE_TENANT_ID` with your Entra tenant ID.
7. In SWA → **Role management** → Invite users by group: assign `SG-Broadway-InternalApps-Users` to the `broadway-employee` role.

### 4. Migrate data from Netlify

Before flipping DNS or telling users:

```bash
npm install
NETLIFY_BASE_URL="https://<your-current-netlify-site>.netlify.app" \
AZURE_STORAGE_CONNECTION_STRING="$STORAGE_CONN" \
NETLIFY_SAVE_DIR="./netlify-backup" \
npm run migrate
```

This pulls all 4 keys (`pilot-revenue`, `wo-snapshot-today`, `wo-snapshot-previous`, `workbook`), saves a local JSON backup, and uploads to Azure Blob Storage.

### 5. Deploy code

Push this repo to GitHub. The workflow at `.github/workflows/azure-static-web-apps.yml` deploys on every push to `main`.

You'll need the deployment token from SWA → **Manage deployment token** → save it as the `AZURE_STATIC_WEB_APPS_API_TOKEN` GitHub Actions secret.

### 6. Smoke test

Visit `https://<swa-hostname>/`. You should be redirected to Microsoft login. After signing in:
- `index.html` should load and the file-list dropdown should populate (proves `/api/data-store?action=list` works).
- `agent.html` should be able to generate emails (proves `/api/generate` and ANTHROPIC_API_KEY work).
- `Broadway_Unified_Ops_Dashboard.html` and `Pilot_Proposal_Diagnostic.html` should load saved snapshots.

## What changed from the Netlify version

| Concern | Netlify | Azure |
|---|---|---|
| Static hosting | `publish = "."` in netlify.toml | SWA, `app_location: "/"` |
| Functions | `/.netlify/functions/<name>` | `/api/<name>` |
| Function signature | `exports.handler = async (event)` | `module.exports = async function (context, req)` |
| Blob storage | `@netlify/blobs` | `@azure/storage-blob` |
| Auth | none (or Netlify Identity) | Entra ID via `staticwebapp.config.json` |
| Secrets | Netlify env vars | SWA app settings → Key Vault references |

The four HTML files were updated with a single find/replace: `/.netlify/functions/` → `/api/`. No other frontend changes.
