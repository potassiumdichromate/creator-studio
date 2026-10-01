import { createHash } from "node:crypto";
import { isObjectStorageConfigured, uploadPublicObject } from "./objectStorageService.js";
import { uploadThumbnail } from "./thumbnailService.js";
import { putBufferOnZeroG } from "./zeroGStorage.js";

// Adapter for the KULT compute layer (../compute-layer): a separate service
// that builds games with a multi-agent DAG on the AI-first KULT Engine.
//
// Enabled with COMPUTE_LAYER_URL. COMPUTE_LAYER_TIERS limits which tiers use it
// (default "1,2,3"). When the compute layer is unreachable or a run fails, the
// callers fall back to the legacy in-process pipeline unless
// COMPUTE_LAYER_FALLBACK=false.
//
// The compute layer returns a gamePackage in this backend's own shape
// (refinement.generatedCode, gameplayAssets.manifest, style, thumbnailUrl), so
// the existing player runs it unchanged. Sprites and the cover are copied into
// this backend's storage (R2, or Mongo-served thumbnails) so games never depend
// on the compute layer's file server.

const POLL_MS = Number(process.env.COMPUTE_LAYER_POLL_MS) || 2000;

// Storage backends used to import assets; swappable in tests.
const defaultStorage = { isObjectStorageConfigured, uploadPublicObject, uploadThumbnail, putBufferOnZeroG };
let storage = defaultStorage;
export function setComputeLayerStorageForTests(impl) {
  storage = impl ? { ...defaultStorage, ...impl } : defaultStorage;
}

export function getComputeLayerConfig() {
  const url = process.env.COMPUTE_LAYER_URL?.trim().replace(/\/+$/, "") || null;
  const tiers = String(process.env.COMPUTE_LAYER_TIERS ?? "1,2,3")
    .split(",").map((t) => Number(t.trim())).filter((t) => [1, 2, 3].includes(t));
  return {
    enabled: Boolean(url),
    url,
    tiers,
    fallback: !/^(0|false|no|off)$/i.test(String(process.env.COMPUTE_LAYER_FALLBACK ?? "true")),
    timeoutMs: Number(process.env.COMPUTE_LAYER_TIMEOUT_MS) || 30 * 60 * 1000,
    hasKey: Boolean(process.env.COMPUTE_LAYER_KEY)
  };
}

export function computeLayerEnabledFor(tier) {
  const config = getComputeLayerConfig();
  return config.enabled && config.tiers.includes(Number(tier));
}

export function codeHash(code) {
  return createHash("sha256").update(String(code ?? "")).digest("hex");
}

async function call(method, path, body) {
  const { url } = getComputeLayerConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${url}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(process.env.COMPUTE_LAYER_KEY ? { "x-compute-key": process.env.COMPUTE_LAYER_KEY } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(`Compute layer ${method} ${path} failed: ${data.error ?? response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Compute layer ${method} ${path} timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// The detailed prompt from the enhancer can be long; the compute layer takes
// up to 4000 characters and its designer expands it anyway.
function clampPrompt(prompt, max) {
  const text = String(prompt ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function progressFromRun(run) {
  const nodes = run.nodes ?? [];
  const finished = nodes.filter((n) => ["done", "degraded", "skipped", "failed", "blocked"].includes(n.status));
  const active = nodes.filter((n) => n.status === "running" || n.status === "waiting");
  return {
    stage: run.status === "awaiting-approval" ? "awaiting-approval" : active.length ? `compute:${active.map((n) => n.id).join(",")}` : "compute",
    completed: finished.length,
    total: nodes.length,
    runId: run.id,
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, status: n.status }))
  };
}

async function waitForRun(runId, { onProgress, timeoutMs }) {
  const started = Date.now();
  let failures = 0;
  for (;;) {
    let run;
    try {
      run = await call("GET", `/v1/runs/${encodeURIComponent(runId)}`);
      failures = 0;
    } catch (error) {
      // Tolerate brief blips (compute layer restarting resumes its runs).
      failures += 1;
      if (failures >= 5) throw error;
      await sleep(POLL_MS * failures);
      continue;
    }
    onProgress?.(progressFromRun(run));
    if (run.status === "complete") return run;
    if (run.status === "failed" || run.status === "cancelled") {
      throw new Error(`Compute run ${runId} ${run.status}: ${run.error ?? "no details"}`);
    }
    if (Date.now() - started > timeoutMs) {
      await call("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`).catch(() => {});
      throw new Error(`Compute run ${runId} exceeded ${Math.round(timeoutMs / 60000)} minutes`);
    }
    await sleep(POLL_MS);
  }
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${url} failed (${response.status})`);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream"
  };
}

const extensionFor = (contentType) => ({ "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/svg+xml": "svg" }[contentType] ?? "bin");

// Same storage path as gameplayAssetService.storeSprite: R2 when configured
// (0G provenance in the background), otherwise the Mongo thumbnail store.
async function storeAsset({ gameId, name, buffer, contentType, objectType }) {
  const safeId = `${String(gameId).replace(/[^a-zA-Z0-9_-]/g, "-")}--asset-${name}`;
  if (storage.isObjectStorageConfigured()) {
    const folder = objectType === "thumbnail" ? "thumbnails" : `sprites/${gameId}`;
    const key = objectType === "thumbnail" ? encodeURIComponent(gameId) : `${name}.${extensionFor(contentType)}`;
    const url = await storage.uploadPublicObject(`${folder}/${key}`, buffer, contentType);
    void storage.putBufferOnZeroG({
      objectType, objectId: objectType === "thumbnail" ? gameId : `${gameId}:${name}`, buffer, contentType,
      fileName: `${name}.${extensionFor(contentType)}`, metadata: { gameId, role: name, source: "compute-layer" }
    }).catch((error) => console.warn("0G provenance upload failed", { gameId, name, message: error.message }));
    return objectType === "thumbnail" ? `${url}?v=${Date.now()}` : url;
  }
  const id = objectType === "thumbnail" ? gameId : safeId;
  const stored = await storage.uploadThumbnail(id, buffer, contentType, `${id}.${extensionFor(contentType)}`);
  return stored.url ?? `/api/thumbnails/${encodeURIComponent(id)}`;
}

// Copies sprites + cover from the compute layer into this backend's storage
// and rewrites the package URLs. Anything that fails to copy keeps its compute
// layer URL (still playable while that server is reachable) and is reported.
async function importAssets(game) {
  const warnings = [];
  const manifest = { ...(game.gameplayAssets?.manifest ?? {}) };
  await Promise.all(Object.entries(manifest).map(async ([name, url]) => {
    try {
      const { buffer, contentType } = await download(url);
      manifest[name] = await storeAsset({ gameId: game.id, name, buffer, contentType, objectType: "game-sprite" });
    } catch (error) {
      warnings.push(`Sprite "${name}" kept on the compute layer: ${error.message}`);
    }
  }));
  let thumbnailUrl = game.thumbnailUrl ?? null;
  if (thumbnailUrl) {
    try {
      const { buffer, contentType } = await download(thumbnailUrl);
      thumbnailUrl = await storeAsset({ gameId: game.id, name: "cover", buffer, contentType, objectType: "thumbnail" });
    } catch (error) {
      warnings.push(`Cover kept on the compute layer: ${error.message}`);
    }
  }
  return { manifest, thumbnailUrl, warnings };
}

// Shapes the compute result like createRefinementBundle's return value, so the
// job result the frontend polls for is unchanged.
function toRefinement({ game, run, quality, refinementLevel, warnings }) {
  const generated = game.refinement ?? {};
  const codeNode = run.nodes.find((n) => n.id === "code" || n.id === "code-edit");
  return {
    jobId: run.id,
    eta: "complete",
    costProfile: "0g-compute-layer",
    refinementLevel: refinementLevel ?? "medium",
    promptBundle: null,
    seededFrom: game.generation?.recipe ?? null,
    source: generated.source ?? "compute-layer",
    provider: "0g",
    model: generated.model ?? codeNode?.models?.[0] ?? null,
    generatedCode: generated.generatedCode,
    usage: run.result?.usage ?? null,
    stages: Object.fromEntries(run.nodes.map((n) => [n.id, { status: n.status, models: n.models, ms: n.ms }])),
    warning: warnings.length ? warnings.join(" ") : null,
    validation: generated.validation ?? [],
    quality: quality ?? null
  };
}

async function finishRun(run, { refinementLevel }) {
  const { game, quality } = await call("GET", `/v1/runs/${encodeURIComponent(run.id)}/package`);
  const { manifest, thumbnailUrl, warnings } = await importAssets(game);
  const refinement = toRefinement({ game, run, quality, refinementLevel, warnings });
  // One line per finished build, so the logs show what the compute layer did.
  const models = [...new Set(run.nodes.flatMap((n) => n.models ?? []))];
  const summary = {
    runId: run.id,
    gameId: game.id,
    seconds: Math.round((run.result?.durationMs ?? 0) / 1000),
    sprites: Object.keys(manifest).length,
    code: quality?.codeSource ?? null,
    acceptance: quality?.acceptance?.ok ?? null,
    playtest: quality?.playtest?.status ?? null,
    degraded: run.nodes.filter((n) => n.status === "degraded" || n.status === "failed").map((n) => n.id),
    models
  };
  console.info("[compute-layer] build complete", summary);
  if (models.some((m) => String(m).startsWith("mock:"))) {
    console.warn("[compute-layer] WARNING: the compute layer ran on its MOCK provider (template game, placeholder art). Set ZERO_G_API_KEY on the compute-layer service.");
  }
  // Fields to merge onto the stored game record.
  const fields = {
    style: game.style,
    gameplayAssets: { ...game.gameplayAssets, manifest },
    ...(thumbnailUrl ? { thumbnailUrl, thumbnailModel: "compute-layer" } : {}),
    "generation.computeRunId": run.id,
    "generation.computeCodeHash": codeHash(refinement.generatedCode),
    "generation.recipe": game.generation?.recipe ?? null,
    "generation.design": game.generation?.design ?? null,
    "generation.computeProvenance": game.generation?.provenance ?? [],
    ...(game.description ? { description: game.description } : {}),
    ...(game.tags?.length ? { tags: game.tags } : {})
  };
  return { refinement, fields, game: { ...game, gameplayAssets: { ...game.gameplayAssets, manifest }, thumbnailUrl }, warnings };
}

/**
 * Builds a game on the compute layer and waits for it.
 * Returns { refinement, fields, game, runId }.
 */
export async function runComputeBuild({ gameId, prompt, tier, refinementLevel, onProgress }) {
  const config = getComputeLayerConfig();
  const created = await call("POST", "/v1/runs", {
    prompt: clampPrompt(prompt, 4000),
    tier: Number(tier),
    ...(gameId && /^[a-zA-Z0-9_-]{4,40}$/.test(gameId) ? { gameId } : {})
  });
  console.info("[compute-layer] build started", { runId: created.id, gameId, tier });
  onProgress?.(progressFromRun(created));
  const run = await waitForRun(created.id, { onProgress, timeoutMs: config.timeoutMs });
  return { ...(await finishRun(run, { refinementLevel })), runId: run.id };
}

/**
 * Applies a change request through the compute layer's edit graph (routes to
 * only the agents the change needs). The parent run must be the one that
 * produced the game's current code.
 */
export async function runComputeEdit({ parentRunId, request, tier, refinementLevel, onProgress }) {
  const config = getComputeLayerConfig();
  const created = await call("POST", `/v1/runs/${encodeURIComponent(parentRunId)}/edits`, {
    request: clampPrompt(request, 2000),
    ...(tier ? { tier: Number(tier) } : {})
  });
  console.info("[compute-layer] edit started", { runId: created.id, parentRunId });
  onProgress?.(progressFromRun(created));
  const run = await waitForRun(created.id, { onProgress, timeoutMs: config.timeoutMs });
  return { ...(await finishRun(run, { refinementLevel })), runId: run.id };
}

/** True when the compute layer can edit this game: it built the exact code the client sent. */
export function computeCanEdit(storedGame, baseCode) {
  const runId = storedGame?.generation?.computeRunId;
  const hash = storedGame?.generation?.computeCodeHash;
  return Boolean(runId && hash && baseCode && codeHash(baseCode) === hash);
}
