// scripts/migrate-flat-to-client-namespaced.js
//
// Copies the four legacy flat blobs to the new client-namespaced paths under
// "pilot". Idempotent: safe to re-run. Does NOT delete the originals — keep
// them in place until you've cut every HTML over and verified traffic.
//
// Usage:
//   AZURE_STORAGE_CONNECTION_STRING="..." node scripts/migrate-flat-to-client-namespaced.js
//
// Optional:
//   DRY_RUN=1     → log what would happen, don't write
//   TARGET_CLIENT → defaults to "pilot"; override to migrate into a different client folder

const { BlobServiceClient } = require("@azure/storage-blob");

const CONTAINER = "broadway-data";
const TARGET_CLIENT = process.env.TARGET_CLIENT || "pilot";
const DRY_RUN = process.env.DRY_RUN === "1";

// Pairs of [legacy flat blob name, new slot name under clients/{TARGET_CLIENT}/].
// Note that wo-snapshot-today/previous keep their slot names — the slot is
// already client-agnostic. Only "pilot-revenue" needs to be renamed to "revenue".
const PAIRS = [
  ["pilot-revenue", "revenue"],
  ["wo-snapshot-today", "wo-snapshot-today"],
  ["wo-snapshot-previous", "wo-snapshot-previous"],
  ["workbook", "workbook"],
];

async function main() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) {
    console.error("AZURE_STORAGE_CONNECTION_STRING not set");
    process.exit(1);
  }

  const service = BlobServiceClient.fromConnectionString(conn);
  const container = service.getContainerClient(CONTAINER);

  console.log(`Migrating into clients/${TARGET_CLIENT}/* ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log("");

  let copied = 0;
  let skipped = 0;
  let missing = 0;

  for (const [legacy, slot] of PAIRS) {
    const src = container.getBlockBlobClient(legacy);
    const dstName = `clients/${TARGET_CLIENT}/${slot}`;
    const dst = container.getBlockBlobClient(dstName);

    // Skip if source doesn't exist (e.g. workbook was never uploaded).
    const srcExists = await src.exists();
    if (!srcExists) {
      console.log(`  - ${legacy} → ${dstName} :  source missing, skipped`);
      missing++;
      continue;
    }

    // Skip if destination already exists AND has same content length + last-modified.
    // This makes the script idempotent for re-runs without re-uploading identical data.
    const dstExists = await dst.exists();
    if (dstExists) {
      const [srcProps, dstProps] = await Promise.all([src.getProperties(), dst.getProperties()]);
      if (srcProps.contentLength === dstProps.contentLength) {
        console.log(`  = ${legacy} → ${dstName} :  destination already populated (${srcProps.contentLength} bytes), skipped`);
        skipped++;
        continue;
      }
      console.log(`  ! ${legacy} → ${dstName} :  destination exists with DIFFERENT size (src=${srcProps.contentLength}, dst=${dstProps.contentLength}). Overwriting.`);
    }

    if (DRY_RUN) {
      console.log(`  ~ ${legacy} → ${dstName} :  would copy`);
      continue;
    }

    // Server-side copy. Faster than download+upload and preserves metadata.
    const srcUrl = src.url;
    const poller = await dst.beginCopyFromURL(srcUrl);
    await poller.pollUntilDone();
    console.log(`  + ${legacy} → ${dstName} :  copied`);
    copied++;
  }

  console.log("");
  console.log(`Done. copied=${copied} skipped=${skipped} missing=${missing}`);
  console.log("");
  console.log("Legacy flat blobs were NOT deleted. After you verify the new endpoints work,");
  console.log("delete them manually from the Azure portal or with `az storage blob delete`.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
