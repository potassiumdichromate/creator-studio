import sharp from "sharp";
import { generateImageAsset, getModelsForTier } from "./zeroGService.js";
import { removeBackground, bufferFromImage } from "./spriteAssetService.js";
import { isR2Configured, uploadPublicObject } from "./r2StorageService.js";
import { uploadThumbnail } from "./thumbnailService.js";
import { putBufferOnZeroG } from "./zeroGStorage.js";

// In-game artwork (NOT cover art). Produces a { role -> url } manifest that the
// generated game's runtime (KULT_RUNTIME.drawAsset) loads and draws. Character
// and object sprites are cut out to transparent PNGs; the environment keeps its
// full background. R2/CDN is the fast "ready" path; 0G provenance is
// fire-and-forget in the background.

function safeId(gameId, role) {
  return `${String(gameId).replace(/[^a-zA-Z0-9_-]/g, "-")}--asset-${role}`;
}

// Store the finished sprite: R2/CDN when configured (fast, cacheable),
// otherwise the Mongo-served thumbnail endpoint as a fallback.
async function storeSprite({ gameId, role, buffer }) {
  const key = `sprites/${gameId}/${role}.png`;
  let url;
  if (isR2Configured()) {
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

// Generates the player/environment/objects assets for a game in parallel and
// returns the manifest the code runtime consumes.
export async function generateGameplayAssets(game, { tier, onProgress } = {}) {
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
