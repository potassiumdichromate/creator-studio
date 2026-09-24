import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Cloudflare R2 (S3-compatible) object storage for game assets: sprites, SVG
// sources and thumbnails. Objects are written under R2_KEY_PREFIX and served
// publicly from R2_PUBLIC_BASE; those URLs are stored on the game records in
// MongoDB, so the frontend loads them straight from R2.

let client;

function getConfig() {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const key = process.env.R2_ACCESS_KEY_ID?.trim();
  const secret = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  const publicBase = process.env.R2_PUBLIC_BASE?.trim();
  if (!accountId || !key || !secret || !bucket || !publicBase) return null;
  return {
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucket,
    key,
    secret,
    publicBase: publicBase.replace(/\/+$/, ""),
    keyPrefix: String(process.env.R2_KEY_PREFIX || "").replace(/^\/+|\/+$/g, "")
  };
}

export function isObjectStorageConfigured() {
  return Boolean(getConfig());
}

function getClient(config) {
  client ??= new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.key,
      secretAccessKey: config.secret
    }
  });
  return client;
}

function fullKey(config, objectKey) {
  return config.keyPrefix ? `${config.keyPrefix}/${objectKey}` : objectKey;
}

/** Public URL for an object key. */
export function publicObjectUrl(objectKey) {
  const config = getConfig();
  return config ? `${config.publicBase}/${fullKey(config, objectKey)}` : null;
}

/**
 * Uploads a buffer as a publicly readable object and returns its public URL.
 * R2 has no per-object ACLs; objects are public through the bucket's public URL.
 * Throws when R2 is not configured or the upload fails.
 */
export async function uploadPublicObject(objectKey, buffer, contentType) {
  const config = getConfig();
  if (!config) {
    const error = new Error("Object storage is not configured (R2_* env vars)");
    error.status = 503;
    throw error;
  }

  await getClient(config).send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: fullKey(config, objectKey),
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable"
    })
  );

  return publicObjectUrl(objectKey);
}
