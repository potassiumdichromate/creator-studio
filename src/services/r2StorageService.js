import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Cloudflare R2 (S3-compatible) object storage for game assets. Uploaded
// objects are served publicly from the bucket's R2.dev/custom domain; their
// URLs are stored on the game/thumbnail records in MongoDB, so the frontend
// renders them directly from that public URL.

let client;

function getConfig() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const key = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  const publicBase = process.env.R2_PUBLIC_BASE;
  if (!accountId || !bucket || !key || !secret || !publicBase) return null;
  return {
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucket,
    key,
    secret,
    publicBase: publicBase.replace(/\/$/, ""),
    // Folder path inside the bucket every object is uploaded under, e.g.
    // "do-backup/creator-studio" — keeps new uploads alongside the migrated ones.
    keyPrefix: (process.env.R2_KEY_PREFIX || "").replace(/^\/+|\/+$/g, "")
  };
}

export function isR2Configured() {
  return Boolean(getConfig());
}

function getClient(config) {
  if (!client) {
    client = new S3Client({
      endpoint: config.endpoint,
      region: "auto",
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.key,
        secretAccessKey: config.secret
      }
    });
  }
  return client;
}

function prefixedKey(config, objectKey) {
  return config.keyPrefix ? `${config.keyPrefix}/${objectKey}` : objectKey;
}

/** Public URL for an object key (served from the R2.dev/custom domain). */
export function publicObjectUrl(objectKey) {
  const config = getConfig();
  if (!config) return null;
  return `${config.publicBase}/${prefixedKey(config, objectKey)}`;
}

/**
 * Uploads a buffer as a publicly-readable object and returns its public URL.
 * Throws when R2 is not configured or the upload fails.
 */
export async function uploadPublicObject(objectKey, buffer, contentType) {
  const config = getConfig();
  if (!config) {
    const error = new Error("R2 storage is not configured (R2_* env vars)");
    error.status = 503;
    throw error;
  }

  // R2 has no per-object ACL concept (unlike DO Spaces) — public read access
  // is a bucket-level setting (the R2.dev "Public Development URL" toggle, or
  // a custom domain mapped to the bucket), already on for R2_PUBLIC_BASE.
  await getClient(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: prefixedKey(config, objectKey),
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable"
    })
  );

  return publicObjectUrl(objectKey);
}
