import sharp from "sharp";
import { callZeroGChat, normalizeTier } from "./zeroGService.js";

// Code-drawn gameplay assets: instead of an image model, a strong LLM writes each
// sprite as SVG. SVG is transparent by default, crisp, and keeps one consistent
// style across the whole set. Flow per game:
//   1. art director  → one style guide + the list of sprites the game needs
//   2. illustrator   → one SVG per sprite (alt frames are drawn from their base)
//   3. review        → the SVG is rendered and shown back to a vision model,
//                      which approves it or returns a corrected SVG
//   4. rasterize     → trimmed transparent PNG for KULT_RUNTIME.drawAsset
// Everything is controlled per tier from .env (TIER{n}_CODE_ASSETS_*); it is off
// unless TIER{n}_CODE_ASSETS_ENABLED=true.

const DEFAULT_MODEL = "claude-opus-5";

export function getCodeAssetConfig(tier) {
  const n = normalizeTier(tier);
  const raw = (suffix) => {
    const value = n ? process.env[`TIER${n}_CODE_ASSETS_${suffix}`] : undefined;
    return value && value.trim() ? value.trim() : null;
  };
  const bool = (suffix, fallback) => {
    const value = raw(suffix);
    return value === null ? fallback : /^(1|true|yes|on)$/i.test(value);
  };
  const num = (suffix, fallback, min, max) => {
    const text = raw(suffix);
    const value = text === null ? NaN : Number(text);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  };
  const model = raw("MODEL") ?? DEFAULT_MODEL;
  const environment = (raw("ENVIRONMENT") ?? "image").toLowerCase();
  return {
    tier: n,
    enabled: Boolean(n) && bool("ENABLED", false),
    model,
    directorModel: raw("DIRECTOR_MODEL") ?? model,
    review: bool("REVIEW", true),
    reviewModel: raw("REVIEW_MODEL") ?? model,
    maxAssets: num("MAX", 6, 1, 10),
    concurrency: num("CONCURRENCY", 4, 1, 8),
    size: num("SIZE", 512, 128, 1024),
    maxTokens: num("MAX_TOKENS", 8000, 2000, 32000),
    // Extra animation frames for the player's move cycle (0-3), drawn from the
    // finished player sprite. 1 = the classic single alternate frame.
    frames: num("FRAMES", 1, 0, 3),
    // Split characters/vehicles into moving part layers the game animates.
    rig: bool("RIG", false),
    environment: ["image", "code", "none"].includes(environment) ? environment : "image"
  };
}

// ---------------------------------------------------------------------------
// SVG hygiene. The model writes the markup, and the user's prompt can steer the
// model, so strip anything that could run script or pull external/local files
// before it reaches sharp (librsvg) or the browser.
// ---------------------------------------------------------------------------
const FORBIDDEN_ELEMENTS = ["script", "foreignObject", "image", "iframe", "video", "audio", "text", "tspan", "textPath"];

export function sanitizeSvg(raw, { width = 256, height = 256 } = {}) {
  let text = String(raw || "").replace(/```(?:svg|xml)?/gi, "");
  const start = text.search(/<svg\b/i);
  const end = text.toLowerCase().lastIndexOf("</svg>");
  if (start < 0 || end < start) throw new Error("No <svg> element in the response");
  let svg = text.slice(start, end + "</svg>".length);

  for (const tag of FORBIDDEN_ELEMENTS) {
    svg = svg
      .replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "")
      .replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), "");
  }
  svg = svg
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "")
    .replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, "none")
    .replace(/@import[^;]*;?/gi, "");

  // Normalize the root: xmlns, a viewBox, and explicit pixel width/height (a
  // root without width/height can report naturalWidth 0 in some browsers).
  const rootMatch = svg.match(/<svg\b[^>]*>/i);
  let root = rootMatch[0];
  const viewBox = root.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1]
    ?? `0 0 ${Number.parseFloat(root.match(/\swidth\s*=\s*["']([\d.]+)/i)?.[1]) || width} ${Number.parseFloat(root.match(/\sheight\s*=\s*["']([\d.]+)/i)?.[1]) || height}`;
  const [, , vbW, vbH] = viewBox.trim().split(/[\s,]+/).map(Number);
  if (!(vbW > 0 && vbH > 0)) throw new Error(`Invalid viewBox "${viewBox}"`);
  root = root
    .replace(/\s(width|height|viewBox|xmlns)\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/<svg\b/i, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${vbW}" height="${vbH}"`);
  svg = svg.replace(rootMatch[0], root);
  if (!/xmlns:xlink/i.test(root) && /xlink:/i.test(svg)) {
    svg = svg.replace(/<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  return { svg, viewBoxWidth: vbW, viewBoxHeight: vbH };
}

// Renders sanitized SVG to a PNG whose longest side is `size` pixels.
async function renderSvg({ svg, viewBoxWidth, viewBoxHeight }, size) {
  const scale = size / Math.max(viewBoxWidth, viewBoxHeight);
  const w = Math.max(1, Math.round(viewBoxWidth * scale));
  const h = Math.max(1, Math.round(viewBoxHeight * scale));
  const sized = svg.replace(/<svg\b[^>]*>/i, (tag) =>
    tag.replace(/\swidth="[^"]*"/, ` width="${w}"`).replace(/\sheight="[^"]*"/, ` height="${h}"`)
  );
  return sharp(Buffer.from(sized), { limitInputPixels: 4096 * 4096 }).png().toBuffer();
}

// Quick visual checks on a render: is anything drawn, and did the model paint a
// full background (all four corners opaque) on something meant to be a sprite?
async function inspectRender(png) {
  const image = sharp(png).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];
  let opaque = 0;
  for (let i = 3; i < data.length; i += info.channels) if (data[i] > 24) opaque += 1;
  const coverage = opaque / (info.width * info.height);
  const corners = [alphaAt(0, 0), alphaAt(info.width - 1, 0), alphaAt(0, info.height - 1), alphaAt(info.width - 1, info.height - 1)];
  return { coverage, opaqueCorners: corners.every((a) => a > 200) };
}

function spriteIssues(inspection, kind) {
  const issues = [];
  if (inspection.coverage < 0.02) issues.push("The render is empty or almost empty — draw the full object so it fills most of the canvas.");
  if (kind !== "background" && inspection.opaqueCorners) issues.push("The render has an opaque background filling the canvas corners — remove the background so everything outside the object is transparent.");
  return issues;
}

// ---------------------------------------------------------------------------
// 1. Art director
// ---------------------------------------------------------------------------
function parseJsonObject(text) {
  const source = String(text || "").replace(/```(?:json)?/gi, "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Art director returned no JSON");
  // Parse as-is first; only if that fails, forgive the common slips (trailing
  // commas, then smart quotes used as delimiters). Anything worse goes back to
  // the model to fix.
  const body = source.slice(start, end + 1);
  const noTrailingCommas = body.replace(/,\s*([}\]])/g, "$1");
  const attempts = [body, noTrailingCommas, noTrailingCommas.replace(/[\u201C\u201D]/g, '"')];
  let firstError;
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}

function gameContext(game) {
  return [
    `Title: ${game.title || "Game"}`,
    `Mechanic: ${game.gameplay?.mechanic || ""}`,
    `Controls: ${game.gameplay?.controls || ""}`,
    `Mood: ${game.visuals?.mood || ""}`,
    `Colors from the design: ${(game.visuals?.colors ?? []).join(", ")}`,
    `Asset ideas from the design: ${typeof game.visuals?.assets === "string" ? game.visuals.assets : JSON.stringify(game.visuals?.assets ?? "")}`,
    `Creator prompt: ${String(game.generation?.prompt || game.customization?.prompt || "").slice(0, 3000)}`
  ].join("\n");
}

export async function designAssetSet(game, config) {
  const wantsCodeBackground = config.environment === "code";
  const messages = [
      {
        role: "system",
        content: [
          "You are the art director of a polished 2D mobile game. Plan the sprite set an illustrator will draw as SVG vector art.",
          "Return ONLY a strictly valid JSON object, no commentary. Never put double quotes inside a string value (use single quotes instead), and no trailing commas:",
          '{"style":{"name":"short style name","palette":["#hex", "... 5-8 colors"],"outline":"outline rule, e.g. 5px rounded outline in #1d1b3a","shading":"shading rule, e.g. soft two-tone cel shading with a top-left highlight","notes":"proportions, mood, detail level"},"assets":[{"name":"player","kind":"character","description":"what it looks like","usage":"how the game uses it","width":256,"height":256,"facing":"right","basedOn":null,"parts":[]}]}',
          "Rules:",
          `- At most ${config.maxAssets} assets${wantsCodeBackground ? " plus one environment background" : ""}. Only sprites this gameplay actually needs.`,
          '- The first asset MUST be "player" (the main playable character or the thing the player controls).',
          config.frames > 0
            ? `- If the player's body changes shape as it moves (running legs, hop squash, a swim stroke), add up to ${config.frames} extra animation frame(s) named ${["player_f2", "player_f3", "player_f4"].slice(0, config.frames).join(", ")}: the SAME character in the next poses of one looping cycle, each with "basedOn":"player".${config.rig ? " Skip frames when the player is a rigid object (car, ship, ball) and use parts instead." : ""}`
            : "- Do not add extra animation frames.",
          config.rig
            ? '- parts: for characters, enemies and vehicles, list up to 4 visible moving parts, e.g. [{"id":"wing_left","motion":"flap"}]. motion is one of spin (wheels, propellers), flap (wings, fins), swing (legs, arms, tail), bob (ears, antennae, hair), blink (eyes), pulse (exhaust flames, jets, glows). Only parts that really move and are visible in this game\'s view (no wheels on a top-down car). Use [] when nothing moves, and always [] for items and frames.'
            : null,
          "- Add the enemies, obstacles, collectibles and key props the gameplay uses. Give each a distinct, readable silhouette.",
          '- Names: unique lowercase snake_case. kind is one of: character, enemy, obstacle, collectible, prop, projectile, effect' + (wantsCodeBackground ? ', background.' : '.'),
          "- width/height are the SVG viewBox size (64–512) and must match the object's real proportions (a long truck is wide, a tree is tall).",
          '- facing is the direction the front of the object points: "right" for side-view games, "up" for top-down games where things travel up the screen (vertical racers, shooters), "down" for things that travel down toward the player in top-down games, "none" for symmetric items like coins. Pick width/height to match (a top-down car facing up is tall).',
          wantsCodeBackground
            ? '- Include exactly one asset named "environment" with kind "background", width 768, height 1152: a full portrait gameplay background with no characters and an open central play area.'
            : "- Do NOT include backgrounds, scenery, ground or sky — the background is made separately.",
          "- No text, logos, UI, buttons or HUD assets — the HUD is drawn in code.",
          "- Never bake ground shadows or drop shadows under objects into the art or the style guide — the game draws those in code so they stay on the ground when things jump or fly.",
          "- One cohesive, appealing style across every asset: bold shapes, a strong palette, clean outlines, soft shading. Aim for premium mobile-game art, not clip-art."
        ].filter(Boolean).join("\n")
      },
      { role: "user", content: gameContext(game) }
  ];

  // One retry with the parse error: a single malformed reply (an unescaped quote
  // in a description, or a reply cut off at the token cap) must not throw away
  // the whole code-drawn path.
  let response;
  let parsed;
  const usages = [];
  for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
    response = await callZeroGChat({ model: config.directorModel, maxTokens: 4000, retries: 2, timeoutMs: 180000, messages });
    usages.push(response.usage);
    try {
      if (response.finishReason === "length") throw new Error("the reply was cut off before the JSON finished");
      parsed = parseJsonObject(response.content);
    } catch (error) {
      if (attempt === 1) throw new Error(`Art director JSON invalid: ${error.message}`);
      messages.push(
        { role: "assistant", content: response.content },
        { role: "user", content: `That was not valid JSON (${error.message}). Return the same plan again as one complete, strictly valid JSON object: keep descriptions short, no double quotes inside strings, no trailing commas.` }
      );
    }
  }
  const seen = new Set();
  const assets = [];
  for (const asset of Array.isArray(parsed.assets) ? parsed.assets : []) {
    const name = String(asset?.name || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
    if (!name || seen.has(name)) continue;
    const isBackground = asset.kind === "background" || name === "environment";
    if (isBackground && !wantsCodeBackground) continue;
    seen.add(name);
    const clamp = (value, fallback) => Math.min(isBackground ? 1152 : 512, Math.max(64, Number(value) || fallback));
    assets.push({
      name,
      kind: isBackground ? "background" : String(asset.kind || "prop"),
      description: String(asset.description || name).slice(0, 600),
      usage: String(asset.usage || "").slice(0, 300),
      width: clamp(asset.width, isBackground ? 768 : 256),
      height: clamp(asset.height, isBackground ? 1152 : 256),
      facing: ["right", "left", "up", "down", "none"].includes(asset.facing) ? asset.facing : "none",
      basedOn: asset.basedOn ? String(asset.basedOn).toLowerCase() : null,
      parts: config.rig && Array.isArray(asset.parts)
        ? asset.parts
            .map((part) => ({
              id: String(part?.id || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, ""),
              motion: String(part?.motion || "").toLowerCase()
            }))
            .filter((part) => part.id && part.id !== "body" && RIG_MOTIONS.includes(part.motion))
            .filter((part, index, list) => list.findIndex((p) => p.id === part.id) === index)
            .slice(0, 4)
        : []
    });
  }
  // MAX counts distinct sprites; extra animation frames come on top, up to FRAMES.
  const bases = assets.filter((a) => a.kind !== "background" && !a.basedOn).slice(0, config.maxAssets);
  const frames = assets
    .filter((a) => a.kind !== "background" && a.basedOn && bases.some((b) => b.name === a.basedOn))
    .slice(0, config.frames)
    .map((a) => ({ ...a, parts: [] }));
  const background = assets.find((a) => a.kind === "background");
  const planned = [...bases, ...frames, ...(background ? [background] : [])];
  if (!planned.some((a) => a.name === "player")) {
    planned.unshift({ name: "player", kind: "character", description: "the main playable character", usage: "the player", width: 256, height: 256, facing: "right", basedOn: null, parts: [] });
  }
  // Alternate frames may point at one existing base frame only. Drop links to a
  // missing asset, to itself, or to another alternate (no chains or cycles),
  // since those would never start.
  for (const asset of planned) {
    const base = planned.find((a) => a.name === asset.basedOn);
    if (!base || base === asset || base.basedOn) asset.basedOn = null;
  }

  return {
    style: parsed.style && typeof parsed.style === "object" ? parsed.style : {},
    assets: planned,
    model: response.model,
    usage: sumUsage(usages)
  };
}

// ---------------------------------------------------------------------------
// 2. Illustrator + 3. review
// ---------------------------------------------------------------------------
const RIG_MOTIONS = ["spin", "flap", "swing", "bob", "blink", "pulse"];

const FACING_RULES = {
  right: "The front of the object points RIGHT (the game flips it for the left direction).",
  left: "The front of the object points LEFT.",
  up: "The front of the object points UP toward the top of the canvas (e.g. a top-down car with its hood at the top).",
  down: "The front of the object points DOWN toward the bottom of the canvas (e.g. an oncoming top-down car with its hood at the bottom)."
};

const RIG_RULES = [
  "LAYERS: this sprite is animated in code, so structure the SVG as optional <defs> followed ONLY by top-level <g> layers in back-to-front order:",
  '- <g id="part-body"> holds everything that does not move;',
  '- one <g id="part-ID" data-pivot="X Y"> per moving part listed in the brief, where X Y is its rotation pivot in viewBox units (wheel or propeller center, wing root, shoulder, hip, tail base; the eye center for blink, the base of a flame or jet for pulse).',
  "Put far-side parts (far leg, far wing) before part-body and near-side parts after it. Never nest one layer inside another and never transform the root. Draw every part in its rest pose, so all layers together look like the finished sprite."
].join("\n");

function illustratorSystem(kind, facing = "right", rigged = false) {
  return [
    "You are a senior game illustrator who draws sprites as hand-written SVG.",
    "Output ONLY one complete <svg>…</svg> element — no markdown fences, no commentary.",
    'Root element: xmlns="http://www.w3.org/2000/svg", viewBox="0 0 W H", width="W", height="H" using the exact size given.',
    kind === "background"
      ? "This is a full background: paint the whole canvas edge to edge."
      : "Transparent background: NEVER draw a rectangle or shape that fills the canvas behind the object. Only the object itself is painted.",
    kind === "background"
      ? "Keep the central play area open and uncluttered; put detail at the edges and in depth layers."
      : "Center the object and make it fill about 85–95% of the canvas without touching or crossing the edges.",
    FACING_RULES[facing] ?? null,
    kind === "background"
      ? null
      : "Do NOT paint a ground shadow or drop-shadow ellipse under the object — the game draws shadows itself.",
    "Allowed: g, path, circle, ellipse, rect, polygon, polyline, line, defs, linearGradient, radialGradient, stop, clipPath, mask, filter with feGaussianBlur/feOffset/feFlood/feComposite/feMerge/feDropShadow, and use with #id references.",
    "Forbidden: text, image, foreignObject, script, external links or url(...) to anything but #ids, CSS animation. This is static art.",
    "Group major parts with ids (body, head, eyes, wings, wheels…).",
    "Quality bar: premium mobile-game art. Bold readable silhouette at small size, clean confident curves, rich gradient shading, a highlight and a shadow on every major form, a consistent outline, appealing proportions and expression. Follow the style guide exactly.",
    "Keep the file compact: clean paths, no huge coordinate noise, under ~14KB.",
    rigged ? RIG_RULES : null
  ].filter(Boolean).join("\n");
}

function assetBrief(asset, style, game) {
  return [
    `Style guide: ${JSON.stringify(style)}`,
    `Game: ${game.title || "Game"} — ${game.gameplay?.mechanic || ""}`,
    `Asset name: ${asset.name}`,
    `Kind: ${asset.kind}`,
    asset.facing && asset.facing !== "none" ? `Facing: the front points ${asset.facing}` : null,
    `Draw: ${asset.description}`,
    asset.usage ? `Used in game as: ${asset.usage}` : null,
    asset.parts?.length && !asset.basedOn ? `Moving parts (separate layers): ${asset.parts.map((p) => `${p.id} (${p.motion})`).join(", ")}` : null,
    `Canvas size: width ${asset.width}, height ${asset.height}`
  ].filter(Boolean).join("\n");
}

async function drawOne({ asset, style, game, config, base }) {
  const started = Date.now();
  const usages = [];
  const renderSize = asset.kind === "background" ? 1152 : config.size;
  const rigged = Boolean(config.rig && asset.parts?.length && !asset.basedOn);
  const baseMessages = [
    { role: "system", content: illustratorSystem(asset.kind, asset.facing, rigged) },
    {
      role: "user",
      content: [
        assetBrief(asset, style, game),
        base
          ? `This is an alternate animation frame of "${base.name}". Redraw EXACTLY the same character — same shapes, colors, outline and proportions — in the new pose described above. Base SVG:\n${base.svg}`
          : null
      ].filter(Boolean).join("\n\n")
    }
  ];

  // Draw, then give the model one chance to fix a response that won't render.
  let drawn;
  let lastError;
  for (let attempt = 0; attempt < 2 && !drawn; attempt += 1) {
    const messages = attempt === 0
      ? baseMessages
      : [...baseMessages, { role: "user", content: `Your previous SVG could not be used: ${lastError}. Output a corrected complete <svg> only.` }];
    const response = await callZeroGChat({ model: config.model, maxTokens: config.maxTokens, retries: 2, timeoutMs: 600000, messages });
    usages.push(response.usage);
    try {
      const clean = sanitizeSvg(response.content, asset);
      const png = await renderSvg(clean, renderSize);
      const issues = spriteIssues(await inspectRender(png), asset.kind);
      if (issues.length && issues[0].startsWith("The render is empty")) throw new Error(issues[0]);
      drawn = { ...clean, png, issues };
    } catch (error) {
      lastError = error.message;
    }
  }
  if (!drawn) throw new Error(`Could not draw "${asset.name}": ${lastError}`);

  // Review: show the model its own render and let it approve or correct it.
  let review = "skipped";
  if (config.review) {
    try {
      const preview = await sharp(drawn.png).flatten({ background: "#d9d9d9" }).png().toBuffer();
      const response = await callZeroGChat({
        model: config.reviewModel,
        maxTokens: config.maxTokens,
        retries: 2,
        timeoutMs: 600000,
        messages: [
          { role: "system", content: illustratorSystem(asset.kind, asset.facing, rigged) },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "Review this render of your SVG sprite (the flat gray is where the sprite is transparent).",
                  assetBrief(asset, style, game),
                  drawn.issues.length ? `Automatic checks found: ${drawn.issues.join(" ")}` : null,
                  "Check: it clearly reads as the described asset, follows the style guide, looks like polished premium game art, is centered and not cropped, has a transparent background (for sprites), and has no stray or broken shapes.",
                  rigged ? "If you correct it, keep the part-* layer groups and their data-pivot attributes exactly as the layer rules require." : null,
                  'If it is already good, reply with exactly the word APPROVED. Otherwise reply with the corrected complete <svg> only.',
                  `Current SVG:\n${drawn.svg}`
                ].filter(Boolean).join("\n\n")
              },
              { type: "image_url", image_url: { url: `data:image/png;base64,${preview.toString("base64")}` } }
            ]
          }
        ]
      });
      usages.push(response.usage);
      if (/<svg\b/i.test(response.content)) {
        try {
          const clean = sanitizeSvg(response.content, asset);
          const png = await renderSvg(clean, renderSize);
          const issues = spriteIssues(await inspectRender(png), asset.kind);
          if (issues.length && issues[0].startsWith("The render is empty")) throw new Error(issues[0]);
          drawn = { ...clean, png, issues };
          review = "fixed";
        } catch {
          review = "fix-rejected";
        }
      } else {
        review = "approved";
      }
    } catch (error) {
      review = `failed: ${error.message}`;
    }
  }

  // Final PNG: trim transparent margins so the sprite box matches the art. The
  // crop box is remembered so rig layers are cut from exactly the same region.
  let png = drawn.png;
  let crop = null;
  if (asset.kind === "background") {
    png = await sharp(png).resize(768, 1152, { fit: "cover", position: "centre" }).png().toBuffer();
  } else {
    try {
      const { data, info } = await sharp(png).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
      png = data;
      crop = { left: -(info.trimOffsetLeft ?? 0), top: -(info.trimOffsetTop ?? 0), width: info.width, height: info.height };
    } catch {
      // trim can fail on unusual renders — keep the untrimmed sprite
    }
  }
  const meta = await sharp(png).metadata();
  crop ??= { left: 0, top: 0, width: meta.width, height: meta.height };

  let rig = null;
  let rigStatus = rigged ? "pending" : "none";
  if (rigged) {
    try {
      rig = await buildRig({ drawn, asset, renderSize, crop });
      rigStatus = `${rig.length} layers`;
    } catch (error) {
      rigStatus = `failed: ${error.message}`;
    }
  }

  return {
    name: asset.name,
    kind: asset.kind,
    description: asset.description,
    usage: asset.usage,
    facing: asset.facing,
    basedOn: asset.basedOn,
    svg: drawn.svg,
    png,
    width: meta.width,
    height: meta.height,
    review,
    rig,
    rigStatus,
    remainingIssues: drawn.issues,
    ms: Date.now() - started,
    tokenUsage: sumUsage(usages)
  };
}

// Splits a layered SVG into one PNG per part-* group. Each layer is rendered on
// the full canvas with every other layer hidden, then cut with the sprite's own
// crop box, so all layers line up exactly when drawn at the same x, y, w, h.
// Pivots are returned as fractions of that box. Throws when the drawing did not
// follow the layer structure, in which case the sprite stays a single image.
export async function buildRig({ drawn, asset, renderSize, crop }) {
  const tagRe = /<g\b[^>]*\bid\s*=\s*["']part-([a-z0-9_-]+)["'][^>]*>/gi;
  const layers = [...drawn.svg.matchAll(tagRe)].map((m) => ({ tag: m[0], part: m[1].replace(/-/g, "_") }));
  if (!layers.some((l) => l.part === "body")) throw new Error("no part-body layer");
  const moving = layers.filter((l) => l.part !== "body");
  if (!moving.length) throw new Error("no moving part layers");

  const hide = (tag) => (/\sdisplay\s*=/.test(tag)
    ? tag.replace(/\sdisplay\s*=\s*("[^"]*"|'[^']*')/, ' display="none"')
    : tag.replace(/^<g\b/, '<g display="none"'));
  const scale = renderSize / Math.max(drawn.viewBoxWidth, drawn.viewBoxHeight);

  const result = [];
  for (const layer of layers) {
    let svg = drawn.svg;
    for (const other of layers) if (other !== layer) svg = svg.replace(other.tag, hide(other.tag));
    const full = await renderSvg({ svg, viewBoxWidth: drawn.viewBoxWidth, viewBoxHeight: drawn.viewBoxHeight }, renderSize);
    const png = await sharp(full).extract(crop).png().toBuffer();
    const { coverage } = await inspectRender(png);
    if (coverage < 0.0005) {
      if (layer.part === "body") throw new Error("part-body layer is empty");
      continue;
    }
    const spec = asset.parts.find((p) => p.id === layer.part);
    const pivotAttr = layer.tag.match(/data-pivot\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)\s*["']/i);
    let pivot = null;
    if (pivotAttr) {
      const px = (Number(pivotAttr[1]) * scale - crop.left) / crop.width;
      const py = (Number(pivotAttr[2]) * scale - crop.top) / crop.height;
      if (Number.isFinite(px) && Number.isFinite(py)) pivot = [Math.min(1.5, Math.max(-0.5, px)), Math.min(1.5, Math.max(-0.5, py))];
    }
    if (!pivot && layer.part !== "body") {
      // No usable pivot: fall back to the centre of the part's own pixels.
      const { info } = await sharp(png).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
      pivot = [(-(info.trimOffsetLeft ?? 0) + info.width / 2) / crop.width, (-(info.trimOffsetTop ?? 0) + info.height / 2) / crop.height];
    }
    result.push({
      part: layer.part,
      motion: layer.part === "body" ? "none" : spec?.motion ?? "none",
      pivot: pivot ? pivot.map((v) => Number(v.toFixed(3))) : null,
      png
    });
  }
  if (!result.some((l) => l.part !== "body")) throw new Error("every moving layer rendered empty");
  return result;
}

function sumUsage(list) {
  return list.filter(Boolean).reduce(
    (total, u) => ({
      prompt_tokens: total.prompt_tokens + (u.prompt_tokens ?? 0),
      completion_tokens: total.completion_tokens + (u.completion_tokens ?? 0),
      total_tokens: total.total_tokens + (u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0))
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  );
}

// Draws every planned asset with bounded concurrency. Base frames go first;
// alternate frames ("basedOn") start once their base SVG exists so the model
// can redraw the same character.
export async function drawAssetSet({ game, design, config, onAssetDone }) {
  const results = new Map();
  const failures = [];
  const pending = [...design.assets];
  const running = new Set();

  const startNext = () => {
    while (running.size < config.concurrency) {
      const index = pending.findIndex((a) => !a.basedOn || results.has(a.basedOn) || failures.some((f) => f.name === a.basedOn));
      if (index < 0) return;
      const [asset] = pending.splice(index, 1);
      const base = asset.basedOn ? results.get(asset.basedOn) : null;
      const job = drawOne({ asset, style: design.style, game, config, base: base ? { name: base.name, svg: base.svg } : null })
        .then((result) => { results.set(asset.name, result); onAssetDone?.(result); })
        .catch((error) => { failures.push({ name: asset.name, error: error.message }); })
        .finally(() => { running.delete(job); });
      running.add(job);
    }
  };

  startNext();
  while (running.size) {
    await Promise.race(running);
    startNext();
  }
  return {
    drawn: design.assets.map((a) => results.get(a.name)).filter(Boolean),
    failures
  };
}
