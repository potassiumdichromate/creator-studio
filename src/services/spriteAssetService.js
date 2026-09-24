import sharp from "sharp";
import { generateImageAsset, getModelsForTier } from "./zeroGService.js";
import { uploadPublicObject } from "./objectStorageService.js";
import { putBufferOnZeroG } from "./zeroGStorage.js";
import { getGameCollection } from "./databaseService.js";

// ─────────────────────────────────────────────────────────────────────────────
//  Sprite asset pipeline
//  Generates real image sprites (character + key objects) for a game, cuts out
//  their background to transparent PNGs, uploads them to R2 (the fast
//  "ready" path) and pushes a provenance copy to 0G in the background. The
//  resulting { name -> url } manifest is stored on the game as `assets.sprites`
//  and can be fed into code generation so games render real sprites instead of
//  code-drawn shapes.
// ─────────────────────────────────────────────────────────────────────────────

const SPRITE_SIZE = 256; // final square sprite dimension
const GEN_SIZE = "1024x1024"; // request a large source, downscale after keying

// Runs `fn` over `items` with at most `limit` in flight — bounded parallelism so
// we generate sprites concurrently without hammering the 0G image endpoint.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        results[index] = { error: error.message, name: items[index]?.name };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Extracts a PNG/JPEG buffer from a 0G image response item (b64 or url).
export async function bufferFromImage(image) {
  if (image?.b64_json) return Buffer.from(image.b64_json, "base64");
  if (image?.url) {
    const res = await fetch(image.url);
    if (!res.ok) throw new Error(`sprite image download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error("image agent returned no sprite image");
}

// Background removal that doesn't depend on the model honouring an exact colour.
// It samples the actual background colour from the image corners, then
// flood-fills inward from every border pixel, turning transparent only the
// CONNECTED region within `tolerance` of that colour. Because it flows from the
// edges, it removes the surrounding background without punching holes inside the
// character (interior pixels aren't reachable through background). Works for any
// roughly-solid background, whatever colour the model actually produced.
export async function removeBackground(buffer, tolerance = 62) {
  // Work at a modest size for speed; the final resize happens by the caller.
  const { data, info } = await sharp(buffer)
    .resize(512, 512, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const idx = (x, y) => (y * width + x) * channels;

  // Background reference = average of the four corners.
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  let br = 0, bg = 0, bb = 0;
  for (const [x, y] of corners) { const i = idx(x, y); br += data[i]; bg += data[i + 1]; bb += data[i + 2]; }
  br /= 4; bg /= 4; bb /= 4;
  const isBg = (i) => Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) < tolerance;

  const visited = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) { stack.push(x, 0, x, height - 1); }
  for (let y = 0; y < height; y++) { stack.push(0, y, width - 1, y); }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const p = y * width + x;
    if (visited[p]) continue;
    visited[p] = 1;
    const i = p * channels;
    if (!isBg(i)) continue;
    data[i + 3] = 0; // transparent
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

// Short, safe descriptor of the game's character/theme, from its own fields.
function themeHint(game) {
  const prompt = String(game?.generation?.prompt || game?.customization?.prompt || "").slice(0, 220);
  const title = String(game?.title || "game").slice(0, 60);
  return { title, prompt };
}

// A small, bounded sprite manifest for a game: always a player character, plus a
// couple of category-appropriate objects. Kept small (≤4) to bound time/cost.
export function buildSpriteManifest(game) {
  const { title, prompt } = themeHint(game);
  const category = String(game?.category || game?.gameplay?.mechanic || "arcade").toLowerCase();
  const base = `Match the game's theme: ${title}. ${prompt}`;

  const objectsByCategory = {
    runner: [["coin", "a shiny collectible coin token"], ["obstacle", "a hazard/obstacle to dodge"]],
    arcade: [["coin", "a shiny collectible point token"], ["enemy", "a simple enemy character"]],
    shooter: [["enemy", "an enemy character to shoot"], ["projectile", "a glowing projectile/bullet"]],
    puzzle: [["tile", "a single colorful game piece/tile"], ["star", "a bright collectible star"]],
    sports: [["ball", "the game's ball"], ["goal", "a goal/target marker"]],
  };
  const objects = objectsByCategory[category] || objectsByCategory.arcade;

  return [
    { name: "player", subject: "the main playable character (full body, front/3-4 view, ready to run/move)" },
    ...objects.map(([name, subject]) => ({ name, subject })),
  ].map((item) => ({
    name: item.name,
    prompt:
      `${item.subject} for a 2D game sprite. ${base}. ` +
      `A single centered object filling most of the frame, clean cartoon/game-art style, bold outline, no text, no border. ` +
      `CRITICAL: isolated on a completely plain, uniform, flat single-color background — no scenery, no floor, no ground, no shadow, no gradient, nothing but one solid color behind the object.`,
  }));
}

// Generates all sprites for a game and stores the manifest on the game record.
// R2 upload is the "ready" path; the 0G provenance copy is fire-and-forget.
export async function generateGameSprites(game, { tier, concurrency = 3 } = {}) {
  if (!game?.id) throw new Error("game.id is required to generate sprites");
  const models = getModelsForTier(tier);
  const manifest = buildSpriteManifest(game);

  const results = await mapPool(manifest, concurrency, async (item) => {
    const generated = await generateImageAsset({
      prompt: item.prompt,
      size: GEN_SIZE,
      models: { image: models.asset }, // per-tier ASSET_MODEL
    });
    const source = await bufferFromImage(generated.images?.[0]);
    const keyed = await removeBackground(source);
    const png = await sharp(keyed)
      .trim({ threshold: 10 }) // crop away empty transparent margins
      .resize(SPRITE_SIZE, SPRITE_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ quality: 90 })
      .toBuffer();

    const objectKey = `sprites/${game.id}/${item.name}.png`;
    const url = await uploadPublicObject(objectKey, png, "image/png");

    // Background 0G provenance (never blocks readiness).
    void putBufferOnZeroG({
      objectType: "game-sprite",
      objectId: `${game.id}:${item.name}`,
      buffer: png,
      contentType: "image/png",
      fileName: `${item.name}.png`,
      metadata: { gameId: game.id, name: item.name },
    }).catch((error) => {
      console.warn("0G sprite provenance upload failed", { gameId: game.id, name: item.name, message: error.message });
    });

    return { name: item.name, url, bytes: png.length };
  });

  const sprites = {};
  const failures = [];
  for (const r of results) {
    if (r && r.url) sprites[r.name] = r.url;
    else if (r) failures.push({ name: r.name, error: r.error });
  }

  await (await getGameCollection()).updateOne(
    { id: game.id },
    { $set: { "assets.sprites": sprites, "assets.spritesModel": models.asset, updatedAt: new Date() } },
  );

  return { gameId: game.id, sprites, failures, count: Object.keys(sprites).length };
}
