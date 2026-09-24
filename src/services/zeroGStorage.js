import crypto from "node:crypto";
import { Indexer, MemData } from "@0gfoundation/0g-storage-ts-sdk";
import { ethers } from "ethers";
import { getDatabase } from "./databaseService.js";

const COLLECTION_NAME = process.env.ZERO_G_STORAGE_COLLECTION || "zero_g_storage_objects";

let indexesReady;

function env(name) {
  return process.env[name]?.trim();
}

function contentHash(buffer) {
  return `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
}

function contentAddress(hash) {
  return hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
}

function safeJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (nested instanceof Date) return nested.toISOString();
    if (typeof nested === "bigint") return nested.toString();
    if (Buffer.isBuffer(nested)) return `[buffer:${nested.length}]`;
    return nested;
  });
}

function storageEnv() {
  return {
    indexerRpc: env("ZERO_G_STORAGE_INDEXER_RPC") || env("ZERO_G_STORAGE_URL"),
    evmRpc: env("ZERO_G_STORAGE_EVM_RPC") || env("ZERO_G_EVM_RPC") || env("WEB3_PROVIDER_URL"),
    privateKey: env("ZERO_G_STORAGE_PRIVATE_KEY") || env("ZERO_G_PRIVATE_KEY"),
    expectedReplica: Number(env("ZERO_G_STORAGE_EXPECTED_REPLICA") || 1)
  };
}

function parseUploadResult(result, fallbackRootHash) {
  if (Array.isArray(result?.txHashes) || Array.isArray(result?.rootHashes)) {
    const rootHashes = result.rootHashes ?? [];
    const txHashes = result.txHashes ?? [];
    return {
      rootHash: rootHashes[0] ?? fallbackRootHash,
      txHash: txHashes[0] ?? null,
      rootHashes,
      txHashes,
      txSeq: null,
      txSeqs: result.txSeqs ?? []
    };
  }

  return {
    rootHash: result?.rootHash || fallbackRootHash,
    txHash: result?.txHash || null,
    rootHashes: result?.rootHash ? [result.rootHash] : [],
    txHashes: result?.txHash ? [result.txHash] : [],
    txSeq: result?.txSeq ?? null,
    txSeqs: []
  };
}

async function collection() {
  const database = await getDatabase();
  const col = database.collection(COLLECTION_NAME);
  if (!indexesReady) {
    indexesReady = Promise.all([
      col.createIndex({ objectType: 1, objectId: 1, createdAt: -1 }),
      col.createIndex({ contentHash: 1 }),
      col.createIndex({ rootHash: 1 }),
      col.createIndex({ txHash: 1 }),
      col.createIndex({ status: 1, createdAt: -1 })
    ]).catch((error) => {
      indexesReady = undefined;
      throw error;
    });
  }
  await indexesReady;
  return col;
}

export function getZeroGStorageConfig() {
  const config = storageEnv();
  return {
    enabled: env("ZERO_G_STORAGE_ENABLED") !== "false",
    configured: Boolean(config.indexerRpc && config.evmRpc && config.privateKey),
    indexerRpc: config.indexerRpc ?? null,
    evmRpc: config.evmRpc ?? null,
    hasPrivateKey: Boolean(config.privateKey),
    expectedReplica: config.expectedReplica,
    collection: COLLECTION_NAME
  };
}

export function isZeroGStorageConfigured() {
  const config = getZeroGStorageConfig();
  return config.enabled && config.configured;
}

async function doUploadToZeroG(buffer) {
  const { indexerRpc, evmRpc, privateKey, expectedReplica } = storageEnv();
  const provider = new ethers.JsonRpcProvider(evmRpc);
  const signer = new ethers.Wallet(privateKey, provider);
  const indexer = new Indexer(indexerRpc);
  const file = new MemData(Uint8Array.from(buffer));
  const [tree, treeError] = await file.merkleTree();
  if (treeError) throw treeError;

  const uploadOptions = {
    expectedReplica
  };
  const [result, uploadError] = await indexer.upload(file, evmRpc, signer, uploadOptions);
  if (uploadError) throw uploadError;

  return {
    ...parseUploadResult(result, tree?.rootHash?.() ?? null),
    raw: result
  };
}

// All uploads sign from the SAME wallet, so running them concurrently collides
// on the account nonce ("replacement fee too low"). Serialize every on-chain
// upload through a single promise chain so nonces stay sequential. Uploads are
// background/fire-and-forget, so the added latency is acceptable.
let uploadChain = Promise.resolve();

// Uploads run one at a time, so a single upload that never finalizes (e.g. a
// storage node that never receives its last segment) would block every later
// upload forever. Cap each one; putBufferOnZeroG records a timeout as "failed"
// and the queue moves on. ZERO_G_STORAGE_UPLOAD_TIMEOUT_MS overrides the cap.
function uploadTimeoutMs() {
  const value = Number(process.env.ZERO_G_STORAGE_UPLOAD_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 180_000;
}

function withUploadTimeout(promise) {
  const ms = uploadTimeoutMs();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`0G storage upload did not finalize within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function uploadToZeroG({ buffer }) {
  if (!isZeroGStorageConfigured()) return null;
  const upload = () => withUploadTimeout(doUploadToZeroG(buffer));
  const run = uploadChain.then(upload, upload);
  // Keep the chain alive regardless of this upload's outcome.
  uploadChain = run.then(() => undefined, () => undefined);
  return run;
}

function unconfiguredReason() {
  const { indexerRpc, evmRpc, privateKey } = storageEnv();
  const missing = [];
  if (!indexerRpc) missing.push("ZERO_G_STORAGE_INDEXER_RPC");
  if (!evmRpc) missing.push("ZERO_G_STORAGE_EVM_RPC");
  if (!privateKey) missing.push("ZERO_G_STORAGE_PRIVATE_KEY");
  if (env("ZERO_G_STORAGE_ENABLED") === "false") missing.push("ZERO_G_STORAGE_ENABLED=false");
  if (missing.length === 0) {
    return "0G Storage is not configured";
  }
  return `Missing ${missing.join(", ")}`;
}

export async function putBufferOnZeroG({
  objectType,
  objectId,
  buffer,
  contentType = "application/octet-stream",
  fileName,
  metadata = {}
}) {
  if (!objectType || !objectId) throw new Error("objectType and objectId are required for 0G storage");
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);

  const now = new Date();
  const hash = contentHash(buffer);
  const baseRecord = {
    objectType,
    objectId,
    contentType,
    fileName: fileName || `${objectType}-${objectId}`,
    byteLength: buffer.length,
    contentHash: hash,
    metadata,
    provider: "0g-storage",
    createdAt: now,
    updatedAt: now
  };

  let record;
  try {
    const uploaded = await uploadToZeroG({
      buffer
    });
    if (uploaded) {
      record = {
        ...baseRecord,
        ...uploaded,
        uri: `0g://${uploaded.rootHash}`,
        status: "uploaded"
      };
    } else {
      record = {
        ...baseRecord,
        rootHash: null,
        txHash: null,
        uri: `sha256://${contentAddress(hash)}`,
        raw: null,
        status: "skipped",
        reason: unconfiguredReason()
      };
    }
  } catch (error) {
    record = {
      ...baseRecord,
      rootHash: null,
      txHash: null,
      uri: `sha256://${contentAddress(hash)}`,
      raw: null,
      status: "failed",
      error: {
        message: error.message,
        status: error.status ?? null,
        details: error.details ?? null
      }
    };
  }

  const col = await collection();
  await col.updateOne(
    { objectType, objectId, contentHash: hash },
    { $set: record, $setOnInsert: { firstSeenAt: now } },
    { upsert: true }
  );

  return {
    objectType,
    objectId,
    status: record.status,
    contentHash: record.contentHash,
    rootHash: record.rootHash,
    txHash: record.txHash,
    uri: record.uri,
    byteLength: record.byteLength
  };
}

export async function putJsonOnZeroG({ objectType, objectId, data, metadata = {}, fileName }) {
  const json = safeJson(data);
  return putBufferOnZeroG({
    objectType,
    objectId,
    buffer: Buffer.from(json),
    contentType: "application/json",
    fileName: fileName || `${objectType}-${objectId}.json`,
    metadata
  });
}

export async function latestZeroGPointer(objectType, objectId) {
  const col = await collection();
  return col.findOne(
    { objectType, objectId },
    { projection: { _id: 0 }, sort: { createdAt: -1 } }
  );
}
