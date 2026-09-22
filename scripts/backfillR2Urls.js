/**
 * Backfill Script: Rewrites thumbnail/sprite URLs stored in MongoDB from the
 * old DigitalOcean Spaces host to the new Cloudflare R2 public URL, so
 * existing thumbnails/games/sprites keep working once DO is cancelled.
 *
 * Run this AFTER the image files themselves have been copied into R2 at the
 * same relative paths (e.g. thumbnails/<id>, sprites/<gameId>/<role>.png)
 * under R2_KEY_PREFIX — this script only rewrites URL strings in Mongo, it
 * does not move any files.
 *
 * Usage:
 *   node scripts/backfillR2Urls.js --dry-run   # preview changes, no writes
 *   node scripts/backfillR2Urls.js             # apply
 *
 * Requires MONGODB_URI and R2_PUBLIC_BASE (+ optional R2_KEY_PREFIX) in .env.
 * Reads the old DigitalOcean base from OLD_DO_BASE (env var), defaulting to
 * this project's known value.
 */

import { resolve } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const OLD_BASE = (
  process.env.OLD_DO_BASE || "https://creator-studio.sfo3.cdn.digitaloceanspaces.com"
).replace(/\/$/, "");
const PUBLIC_BASE = process.env.R2_PUBLIC_BASE?.replace(/\/$/, "");
const KEY_PREFIX = (process.env.R2_KEY_PREFIX || "").replace(/^\/+|\/+$/g, "");
const NEW_BASE = PUBLIC_BASE ? `${PUBLIC_BASE}${KEY_PREFIX ? `/${KEY_PREFIX}` : ""}` : null;

const DRY_RUN = process.argv.includes("--dry-run");

// Recursively walks a document and collects every dot-path whose string
// value starts with OLD_BASE, so we can $set exactly those fields — this
// finds thumbnailUrl, thumbnails.url, assets.sprites.*, gameplayAssets.
// manifest.*, and anything else shaped the same way, without hardcoding
// every field path.
function collectUpdates(value, path, updates) {
  if (typeof value === "string") {
    if (value.startsWith(OLD_BASE)) {
      updates.push({ path, value: NEW_BASE + value.slice(OLD_BASE.length) });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectUpdates(item, `${path}.${i}`, updates));
    return;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === "_id") continue;
      collectUpdates(v, path ? `${path}.${k}` : k, updates);
    }
  }
}

async function backfillCollection(db, collectionName) {
  const collection = db.collection(collectionName);
  const cursor = collection.find({});
  let scanned = 0;
  let changed = 0;
  let fieldsChanged = 0;

  for await (const doc of cursor) {
    scanned++;
    const updates = [];
    collectUpdates(doc, "", updates);
    if (!updates.length) continue;

    changed++;
    fieldsChanged += updates.length;
    console.log(`  ${collectionName}/${doc._id}: ${updates.map((u) => u.path).join(", ")}`);

    if (!DRY_RUN) {
      const $set = Object.fromEntries(updates.map((u) => [u.path, u.value]));
      await collection.updateOne({ _id: doc._id }, { $set });
    }
  }

  return { scanned, changed, fieldsChanged };
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI not set in .env");
    process.exit(1);
  }
  if (!NEW_BASE) {
    console.error("R2_PUBLIC_BASE not set in .env — set it (and R2_KEY_PREFIX) before running.");
    process.exit(1);
  }

  console.log(`Rewriting URLs: ${OLD_BASE} -> ${NEW_BASE}${DRY_RUN ? "  (dry run, no writes)" : ""}`);

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db();

  const thumbnailsResult = await backfillCollection(db, "thumbnails");
  const gamesCollectionName = process.env.MONGODB_COLLECTION || "prompt_creator_studio";
  const gamesResult = await backfillCollection(db, gamesCollectionName);

  console.log("\nDone.");
  console.log(`  thumbnails: ${thumbnailsResult.changed}/${thumbnailsResult.scanned} docs, ${thumbnailsResult.fieldsChanged} fields`);
  console.log(`  ${gamesCollectionName}: ${gamesResult.changed}/${gamesResult.scanned} docs, ${gamesResult.fieldsChanged} fields`);

  await client.close();
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
