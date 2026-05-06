#!/usr/bin/env node
/**
 * One-time migration: copy data from Netlify Blobs to Azure Blob Storage.
 *
 * Usage:
 *   NETLIFY_BASE_URL="https://your-site.netlify.app" \
 *   AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=..." \
 *   node scripts/migrate-from-netlify.js
 *
 * Optional: NETLIFY_SAVE_DIR=./netlify-backup to also dump JSON to disk as a safety net.
 */

const fs = require("fs");
const path = require("path");
const { BlobServiceClient } = require("@azure/storage-blob");

const CONTAINER_NAME = "broadway-data";
const KEYS = ["pilot-revenue", "wo-snapshot-today", "wo-snapshot-previous", "workbook"];

async function main() {
  const base = process.env.NETLIFY_BASE_URL;
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const saveDir = process.env.NETLIFY_SAVE_DIR;

  if (!base) throw new Error("NETLIFY_BASE_URL is required (e.g. https://your-site.netlify.app)");
  if (!conn) throw new Error("AZURE_STORAGE_CONNECTION_STRING is required");

  if (saveDir) fs.mkdirSync(saveDir, { recursive: true });

  const service = BlobServiceClient.fromConnectionString(conn);
  const container = service.getContainerClient(CONTAINER_NAME);
  await container.createIfNotExists();
  console.log(`Azure container "${CONTAINER_NAME}" ready.`);

  for (const key of KEYS) {
    const url = `${base}/.netlify/functions/data-store?key=${encodeURIComponent(key)}`;
    process.stdout.write(`Fetching ${key} ... `);
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`SKIP (HTTP ${res.status})`);
      continue;
    }
    const payload = await res.json();
    if (!payload.exists) {
      console.log("not present, skipping.");
      continue;
    }

    if (saveDir) {
      fs.writeFileSync(path.join(saveDir, `${key}.json`), JSON.stringify(payload, null, 2));
    }

    const body = JSON.stringify(payload.data);
    const blob = container.getBlockBlobClient(key);
    const flatMeta = {};
    for (const [k, v] of Object.entries(payload.metadata || {})) {
      if (v === null || v === undefined) continue;
      flatMeta[k] = typeof v === "string" ? v : String(v);
    }
    await blob.upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: "application/json" },
      metadata: flatMeta,
    });
    console.log(`uploaded (${(body.length / 1024).toFixed(1)} KB).`);
  }

  console.log("\nMigration complete. Verify in Azure Storage Explorer or with:");
  console.log(`  az storage blob list --container-name ${CONTAINER_NAME} --connection-string "$AZURE_STORAGE_CONNECTION_STRING" --output table`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
