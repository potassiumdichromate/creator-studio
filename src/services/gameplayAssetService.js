import sharp from "sharp";
import { generateImageAsset, getModelsForTier } from "./zeroGService.js";
import { removeBackground, bufferFromImage } from "./spriteAssetService.js";
import { isObjectStorageConfigured, uploadPublicObject } from "./objectStorageService.js";
import { uploadThumbnail } from "./thumbnailService.js";
import { putBufferOnZeroG } from "./zeroGStorage.js";
import { getCodeAssetConfig, designAssetSet, drawAssetSet } from "./codeAssetService.js";

// In-game artwork (NOT cover art). Produces a { role -> url } manifest that the
// generated game's runtime (KULT_RUNTIME.drawAsset) loads and draws. Character
// and object sprites are cut out to transparent PNGs; the environment keeps its
// full background. R2 is the fast "ready" path; 0G provenance is
// fire-and-forget in the background.

function safeId(gameId, role) {
  return `${String(gameId).replace(/[^a-zA-Z0-9_-]/g, "-")}--asset-${role}`;
}

// Store the finished sprite in the object store (Cloudflare R2) when
// configured, otherwise the Mongo-served thumbnail endpoint.
async function storeSprite({ gameId, role, buffer }) {
  const key = `sprites/${gameId}/${role}.png`;
  let url;
  if (isObjectStorageConfigured()) {
    url = await uploadPublicObject(key, buffer, "image/png");
  } else {
    const id = safeId(gameId, role);
    await uploadThumbnail(id, buffer, "image/png", `${id}.png`);
    url = `/api/thumbnails/${encodeURIComponent(id)}`;
  }
  // Background 0G provenance — never blocks readiness.
  void putBufferOnZeroG({
    objectType: "game-sprite",
    objectId: `${gameId}:${role}`,
    buffer,
    contentType: "image/png",
    fileName: `${role}.png`,
    metadata: { gameId, role },
  }).catch((error) => {
    console.warn("0G sprite provenance upload failed", { gameId, role, message: error.message });
  });
  return url;
}

export function planGameplayAssets(game) {
  const gameId = game?.id;
  if (!gameId) throw new Error("game.id is required for gameplay assets");
  const title = game.title || "Game";
  const spec = String(
    game.generation?.prompt || game.customization?.prompt || game.gameplay?.mechanic || ""
  ).slice(0, 4000);
  const shared = `Game: ${title}. ${spec}. Original production-quality in-game artwork, not cover art. No logos, no title text, no watermark, no frame, no UI.`;
  const solidBg =
    "CRITICAL: isolated on a completely plain, uniform, flat SINGLE-COLOR background — no scenery, no floor, no ground, no shadow, no gradient — so it can be cut out cleanly.";

  return [
    {
      role: "player",
      transparent: true,
      size: "1024x1024",
      prompt: `${shared} The main playable character, single figure, clear full-body action pose, centered, readable silhouette, game-ready character art. ${solidBg}`,
    },
    {
      role: "environment",
      transparent: false,
      size: "1024x1536",
      prompt: `${shared} A tall portrait gameplay BACKGROUND scene matching the requested world, layered depth, no characters, open central play space, seamless-feeling, game-ready background art.`,
    },
    {
      role: "objects",
      transparent: true,
      size: "1024x1024",
      prompt: `${shared} A single clear game object/collectible/obstacle prop from the requested world, centered, consistent scale and lighting, game-ready prop art. ${solidBg}`,
    },
  ];
}

async function generateOne({ gameId, item, model }) {
  const generated = await generateImageAsset({ prompt: item.prompt, size: item.size, models: { image: model } });
  const source = await bufferFromImage(generated.images?.[0]);

  let buffer;
  if (item.transparent) {
    const keyed = await removeBackground(source);
    buffer = await sharp(keyed)
      .trim({ threshold: 10 })
      .resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ quality: 90 })
      .toBuffer();
  } else {
    // Environment keeps its full background; normalize to a portrait canvas.
    buffer = await sharp(source).resize(768, 1152, { fit: "cover", position: "centre" }).png({ quality: 88 }).toBuffer();
  }
  const url = await storeSprite({ gameId, role: item.role, buffer });
  return { role: item.role, url, model, transparent: item.transparent };
}

// Keeps the SVG source next to the PNG in the object store so a sprite can be
// re-rasterized or edited later. Best-effort: never blocks the build.
async function storeSpriteSvg({ gameId, role, svg }) {
  if (!isObjectStorageConfigured()) return null;
  try {
    return await uploadPublicObject(`sprites/${gameId}/${role}.svg`, Buffer.from(svg), "image/svg+xml");
  } catch (error) {
    console.warn("SVG sprite source upload failed", { gameId, role, message: error.message });
    return null;
  }
}

// Code-drawn path (enabled per tier from .env): an LLM designs and draws the
// sprite set as SVG, and the background comes from the image model in parallel
// (TIER{n}_CODE_ASSETS_ENVIRONMENT=image), from SVG (=code) or is skipped (=none).
async function generateCodeDrawnGameplayAssets(game, { tier, config, onProgress }) {
  const started = Date.now();
  const models = getModelsForTier(tier);
  const warnings = [];

  // Settles to { value } or { error } so it can never become an unhandled
  // rejection if the sprite path throws before we await it.
  const environmentPromise = config.environment === "image"
    ? (async () => {
        const t = Date.now();
        const item = planGameplayAssets(game).find((entry) => entry.role === "environment");
        const asset = await generateOne({ gameId: game.id, item, model: models.asset });
        return { ...asset, ms: Date.now() - t };
      })().then((value) => ({ value }), (error) => ({ error }))
    : Promise.resolve({ value: null });

  const directorStarted = Date.now();
  const design = await designAssetSet(game, config);
  const directorMs = Date.now() - directorStarted;
  onProgress?.({ stage: "generating-assets", completed: 0, total: design.assets.length });

  let completed = 0;
  const { drawn, failures } = await drawAssetSet({
    game,
    design,
    config,
    onAssetDone: () => {
      completed += 1;
      onProgress?.({ stage: "generating-assets", completed, total: design.assets.length });
    }
  });
  for (const failure of failures) warnings.push(`Sprite "${failure.name}" skipped: ${failure.error}`);

  const stored = await Promise.all(
    drawn.map(async (asset) => {
      const [url, svgUrl, rigLayers] = await Promise.all([
        storeSprite({ gameId: game.id, role: asset.name, buffer: asset.png }),
        storeSpriteSvg({ gameId: game.id, role: asset.name, svg: asset.svg }),
        // Rig layers are stored as their own sprites (NAME__PART) so the game can
        // draw and rotate each one; a layer that fails to store drops the rig.
        asset.rig
          ? Promise.all(asset.rig.map(async (layer) => ({
              layer: `${asset.name}__${layer.part}`,
              part: layer.part,
              motion: layer.motion,
              pivot: layer.pivot,
              url: await storeSprite({ gameId: game.id, role: `${asset.name}__${layer.part}`, buffer: layer.png })
            }))).catch((error) => {
              warnings.push(`Rig for "${asset.name}" skipped: ${error.message}`);
              return null;
            })
          : Promise.resolve(null)
      ]);
      return { ...asset, url, svgUrl, rigLayers };
    })
  );

  const { value: environment = null, error: environmentError } = await environmentPromise;
  if (environmentError) warnings.push(`Environment background skipped: ${environmentError.message}`);

  const manifest = Object.fromEntries(stored.flatMap((asset) => [
    [asset.name, asset.url],
    ...(asset.rigLayers ?? []).map((layer) => [layer.layer, layer.url])
  ]));
  if (environment && !manifest.environment) manifest.environment = environment.url;

  const catalog = stored.map((asset) => ({
    name: asset.name,
    kind: asset.kind,
    description: asset.description,
    usage: asset.usage,
    facing: asset.facing ?? "none",
    basedOn: asset.basedOn,
    width: asset.width,
    height: asset.height,
    aspect: Number((asset.width / asset.height).toFixed(3)),
    ...(asset.rigLayers ? { rig: asset.rigLayers.map(({ url, ...layer }) => { void url; return layer; }) } : {})
  }));
  if (environment && !catalog.some((entry) => entry.name === "environment")) {
    catalog.push({
      name: "environment",
      kind: "background",
      description: "full-screen gameplay background",
      usage: "draw first each frame, covering the whole canvas",
      facing: "none",
      basedOn: null,
      width: 768,
      height: 1152,
      aspect: Number((768 / 1152).toFixed(3))
    });
  }

  const tokens = [design.usage, ...stored.map((asset) => asset.tokenUsage)].filter(Boolean).reduce(
    (total, u) => ({
      prompt_tokens: total.prompt_tokens + (u.prompt_tokens ?? 0),
      completion_tokens: total.completion_tokens + (u.completion_tokens ?? 0)
    }),
    { prompt_tokens: 0, completion_tokens: 0 }
  );

  return {
    status: Object.keys(manifest).length ? "ready" : "failed",
    source: "code",
    generatedAt: new Date(),
    model: config.model,
    models: {
      director: config.directorModel,
      illustrator: config.model,
      review: config.review ? config.reviewModel : null,
      environment: config.environment === "image" ? models.asset : config.environment
    },
    style: design.style,
    manifest,
    catalog,
    assets: [
      ...stored.map(({ png, svg, tokenUsage, rig, ...rest }) => { void png; void svg; void rig; return { ...rest, tokens: tokenUsage }; }),
      ...(environment ? [{ name: "environment", url: environment.url, model: environment.model, ms: environment.ms }] : [])
    ],
    usage: tokens,
    timings: {
      directorMs,
      sprites: Object.fromEntries(stored.map((asset) => [asset.name, asset.ms])),
      environmentMs: environment?.ms ?? null,
      totalMs: Date.now() - started
    },
    warnings
  };
}

// Generates the player/environment/objects assets for a game in parallel and
// returns the manifest the code runtime consumes. When code-drawn assets are
// enabled for the tier, the LLM/SVG path runs instead (and falls back to this
// image path if it throws before producing anything).
export async function generateGameplayAssets(game, { tier, onProgress } = {}) {
  const codeConfig = getCodeAssetConfig(tier);
  if (codeConfig.enabled) {
    try {
      const result = await generateCodeDrawnGameplayAssets(game, { tier, config: codeConfig, onProgress });
      if (result.status === "ready") return result;
      console.warn("Code-drawn assets produced nothing; falling back to image sprites", { gameId: game.id, warnings: result.warnings });
    } catch (error) {
      console.warn("Code-drawn assets failed; falling back to image sprites", { gameId: game.id, message: error.message });
    }
  }
  const plan = planGameplayAssets(game);
  const models = getModelsForTier(tier);
  onProgress?.({ stage: "generating-assets", completed: 0, total: plan.length });
  let completed = 0;
  const settled = await Promise.allSettled(
    plan.map(async (item) => {
      const asset = await generateOne({ gameId: game.id, item, model: models.asset });
      completed += 1;
      onProgress?.({ stage: "generating-assets", completed, total: plan.length });
      return asset;
    })
  );
  const assets = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  return {
    status: assets.length ? "ready" : "failed",
    generatedAt: new Date(),
    model: models.asset,
    manifest: Object.fromEntries(assets.map((asset) => [asset.role, asset.url])),
    assets,
  };
}

export function gameplayAssetManifest(game) {
  return Object.fromEntries(planGameplayAssets(game).map(({ role }) => [role, safeId(game.id, role)]));
}
