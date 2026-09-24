import { getDatabase, getGameCollection } from "./databaseService.js";
import sharp from "sharp";
import { isObjectStorageConfigured, uploadPublicObject } from "./objectStorageService.js";
import { generateImageAsset } from "./zeroGService.js";
import { putBufferOnZeroG } from "./zeroGStorage.js";
import { logActivityOnChain, ACTIVITY } from "./zeroGActivityLog.js";

const COLLECTION_NAME = "thumbnails";
const THUMBNAIL_WIDTH = 384;
const THUMBNAIL_HEIGHT = 576;

export async function getThumbnailCollection() {
  const database = await getDatabase();
  return database.collection(COLLECTION_NAME);
}

export async function uploadThumbnail(templateId, buffer, contentType, fileName) {
  const collection = await getThumbnailCollection();
  const zeroGStorage = await putBufferOnZeroG({
    objectType: "thumbnail",
    objectId: templateId,
    buffer,
    contentType,
    fileName,
    metadata: { templateId }
  });
  // 0G on-chain: an asset-stored event.
  logActivityOnChain(ACTIVITY.ASSET_STORED, templateId);

  // Primary store is the object store (Cloudflare R2) — Mongo keeps only the
  // public URL. If that upload fails, fall through to Mongo binary storage
  // instead of losing the thumbnail.
  const storeUrl = async () => (isObjectStorageConfigured()
    ? uploadPublicObject(`thumbnails/${encodeURIComponent(templateId)}`, buffer, contentType)
    : null);
  let url = null;
  try {
    url = await storeUrl();
  } catch (error) {
    console.warn("Thumbnail store failed; keeping it in Mongo instead", { templateId, message: error.message });
  }
  if (url) {
    await collection.updateOne(
      { templateId },
      {
        $set: { templateId, url, contentType, fileName, zeroGStorage, updatedAt: new Date() },
        $unset: { data: "" },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
    return { templateId, contentType, fileName, url };
  }

  // Fallback (no store configured, or it failed): legacy binary storage.
  await collection.updateOne(
    { templateId },
    {
      $set: { templateId, data: buffer, contentType, fileName, zeroGStorage, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );
  return { templateId, contentType, fileName, zeroGStorage };
}

export async function getThumbnail(templateId) {
  const collection = await getThumbnailCollection();
  return collection.findOne({ templateId });
}

export async function listThumbnailIds() {
  const collection = await getThumbnailCollection();
  return collection
    .find({}, { projection: { templateId: 1, contentType: 1, fileName: 1, _id: 0 } })
    .toArray();
}

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Thumbnail download failed with status ${response.status}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || "image/png"
  };
}

/**
 * Generates a cover image for a freshly generated game (hybrid or pure-agent),
 * downloads it, stores the binary in the thumbnails collection like every
 * other image, and points the saved game record at the served URL.
 * Runs as a background job — never blocks game generation.
 */
// A short, uppercase cover title (max 3 words) — image models render short
// text far more legibly than long strings, so we trim the game title down.
export function coverTitle(title) {
  const cleaned = String(title || "").replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned.split(" ").slice(0, 3).join(" ") || "GAME").toUpperCase();
}

// Deterministic gradient from the game id so each fallback cover looks distinct.
function fallbackGradient(seed) {
  const palettes = [
    ["#7c3aed", "#d946ef", "#0b0419"], ["#0ea5e9", "#22d3ee", "#0b1220"],
    ["#f59e0b", "#db2777", "#1a0b0b"], ["#10b981", "#14b8a6", "#04140f"],
    ["#ef4444", "#f97316", "#1a0705"], ["#6366f1", "#8b5cf6", "#0a0a1f"]
  ];
  let h = 0;
  for (const ch of String(seed || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palettes[h % palettes.length];
}

// A real WEBP cover rendered locally (no SVG data-URI, no network). Used only
// when the image model can't produce a picture, so EVERY game still ends up
// with a proper webp thumbnail hosted the same way as generated ones.
async function renderFallbackCoverWebp(game) {
  const [c1, c2, bg] = fallbackGradient(game.id);
  const title = coverTitle(game.title);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMBNAIL_WIDTH}" height="${THUMBNAIL_HEIGHT}" viewBox="0 0 384 576">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="0.55" stop-color="${c2}"/><stop offset="1" stop-color="${bg}"/>
    </linearGradient></defs>
    <rect width="384" height="576" fill="${bg}"/>
    <rect x="14" y="14" width="356" height="548" rx="26" fill="url(#g)"/>
    <circle cx="110" cy="180" r="90" fill="#ffffff" opacity="0.12"/>
    <path d="M40 470 L150 250 L230 380 L290 270 L344 470 Z" fill="#000000" opacity="0.28"/>
    <rect x="34" y="470" width="316" height="72" rx="16" fill="#000000" opacity="0.55"/>
    <text x="192" y="516" text-anchor="middle" fill="#ffffff" font-family="Arial,Helvetica,sans-serif" font-size="30" font-weight="800">${title.replace(/[<&>]/g, "")}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer();
}

export async function generateAndStoreGameThumbnail(game) {
  if (!game?.id) throw new Error("game.id is required for thumbnail generation");

  const prompt = [
    `${game.title} game cover art`,
    game.generation?.prompt || game.prompt || game.customization?.prompt,
    game.gameplay?.mechanic,
    game.visuals?.mood,
    (game.visuals?.colors ?? []).slice(0, 3).join(" "),
    `the bold uppercase title "${coverTitle(game.title)}" spelled exactly, in a clean large display font across the top like a game cover`,
    "polished colorful game cover art, clear gameplay subject, crisp legible lettering",
    "vertical 2:3 portrait composition, keep the title and important subjects inside safe margins"
  ].filter(Boolean).join(", ");

  // Request a native 2:3 portrait composition, then normalize the stored file
  // to the exact dimensions used by mobile and tablet game cards. generateImageAsset
  // already has an internal timeout + retries; if the image model still can't
  // deliver, we render a real webp cover locally instead of throwing — so the
  // job ALWAYS finishes with a webp, never hangs, and never leaves an SVG.
  let result = { model: null };
  let buffer;
  let contentType = "image/webp";
  let usedFallback = false;
  try {
    let generated;
    try {
      generated = await generateImageAsset({ prompt, size: "1024x1536" });
    } catch {
      generated = await generateImageAsset({ prompt });
    }
    result = generated;
    const image = generated.images?.[0];
    let source;
    let sourceType = "image/png";
    if (image?.b64_json) {
      source = Buffer.from(image.b64_json, "base64");
    } else if (image?.url) {
      ({ buffer: source, contentType: sourceType } = await downloadImage(image.url));
    } else {
      throw new Error("Image agent returned no image");
    }
    void sourceType;
    buffer = await sharp(source)
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "cover", position: "centre" })
      .webp({ quality: 88 })
      .toBuffer();
  } catch (error) {
    console.warn("Thumbnail image model unavailable; rendering webp fallback cover", { gameId: game.id, message: error.message });
    buffer = await renderFallbackCoverWebp(game);
    result = { model: "webp-fallback" };
    usedFallback = true;
  }

  // Primary store: Cloudflare R2 — the public URL goes onto the game
  // record in MongoDB and the frontend renders it directly. Falls back to the
  // Mongo-served thumbnail when R2 is unavailable.
  const zeroGStorage = await putBufferOnZeroG({
    objectType: "thumbnail",
    objectId: game.id,
    buffer,
    contentType,
    fileName: `${game.id}.webp`,
    metadata: {
      gameId: game.id,
      title: game.title ?? null,
      sourceModel: result.model ?? null,
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT
    }
  });
  let thumbnailUrl;
  if (isObjectStorageConfigured()) {
    try {
      const uploadedUrl = await uploadPublicObject(
        `thumbnails/${encodeURIComponent(game.id)}`,
        buffer,
        contentType
      );
      thumbnailUrl = `${uploadedUrl}?v=${Date.now()}`;
    } catch (error) {
      console.warn("Object storage upload failed; falling back to Mongo thumbnail", { message: error.message });
    }
  }
  if (!thumbnailUrl) {
    await uploadThumbnail(game.id, buffer, contentType, `${game.id}.webp`);
    thumbnailUrl = `/api/thumbnails/${encodeURIComponent(game.id)}`;
  }

  const games = await getGameCollection();
  await games.updateOne(
    { id: game.id },
    {
      $set: {
        thumbnailUrl,
        thumbnailModel: result.model,
        thumbnailWidth: THUMBNAIL_WIDTH,
        thumbnailHeight: THUMBNAIL_HEIGHT,
        thumbnailZeroGStorage: zeroGStorage,
        thumbnailIsFallback: usedFallback,
        updatedAt: new Date()
      }
    }
  );

  return {
    gameId: game.id,
    thumbnailUrl,
    model: result.model,
    usedFallback,
    bytes: buffer.length,
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    zeroGStorage
  };
}
