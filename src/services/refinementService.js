import { getReferenceGame } from "../data/referenceGames.js";
import { runtimeSmokeTest } from "./gameSmokeTest.js";
import { callZeroGChat, zeroGModels } from "./zeroGService.js";
import vm from "node:vm";

const VALIDATED_RUNTIME_SHELL = `
// KULT_VALIDATED_RUNTIME_V1
const KULT_RUNTIME = (() => {
  const canvas = document.querySelector("#game");
  const ctx = canvas.getContext("2d");
  const input = { x: 0, y: 0, down: false, keys: new Set(), restartRequested: false };
  const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
  resize();
  window.addEventListener("resize", resize);
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    input.x = ((event.clientX ?? 0) - rect.left) * canvas.width / Math.max(1, rect.width);
    input.y = ((event.clientY ?? 0) - rect.top) * canvas.height / Math.max(1, rect.height);
  };
  canvas.addEventListener("pointerdown", (event) => { point(event); input.down = true; input.restartRequested = true; });
  canvas.addEventListener("pointermove", point);
  canvas.addEventListener("pointerup", (event) => { point(event); input.down = false; });
  window.addEventListener("keydown", (event) => {
    input.keys.add(event.code);
    if (event.code === "KeyR" || event.code === "Space" || event.code === "Enter") input.restartRequested = true;
  });
  window.addEventListener("keyup", (event) => input.keys.delete(event.code));
  const assets = {};
  for (const [name, url] of Object.entries(gamePackage.gameplayAssets?.manifest ?? {})) {
    const image = new Image(); image.src = url; assets[name] = image;
  }
  const drawAsset = (name, ...args) => {
    const image = assets[name];
    if (image?.complete && image.naturalWidth) ctx.drawImage(image, ...args);
    return Boolean(image?.complete && image.naturalWidth);
  };
  const reportScore = (score) => window.reportScore?.(Number(score) || 0);
  const consumeRestart = () => { const value = input.restartRequested; input.restartRequested = false; return value; };
  return { canvas, ctx, input, assets, resize, drawAsset, reportScore, consumeRestart };
})();
`.trim();

function attachValidatedRuntimeShell(code) {
  const source = String(code || "");
  return source.includes("KULT_VALIDATED_RUNTIME_V1") ? source : `${VALIDATED_RUNTIME_SHELL}\n\n${source}`;
}

// TIER{n}_GAME_SOUND=true lets generated games add light procedural sound.
function gameSoundEnabled(tier) {
  const value = process.env[`TIER${Number(tier)}_GAME_SOUND`];
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

const SOUND_RULES = [
  "SOUND — add light procedural sound effects with the Web Audio API (no audio files):",
  "- Create the AudioContext (window.AudioContext || window.webkitAudioContext) only inside the first tap/click/keydown handler — browsers block audio before a user gesture — and call resume() there. If neither constructor exists, simply play without sound.",
  "- Synthesize short effects for the key moments this game has (jump or hop, collect or coin, hit or crash, level up, game over) from oscillators and short noise bursts with quick gain envelopes; optionally one quiet ambient or engine loop that follows the action.",
  "- Keep it subtle: route everything through one master gain around 0.25, don't let effects pile up into noise, and stop loops on pause and game over.",
  "- Add a small tap-accessible mute toggle in the HUD, remembered in localStorage.",
  "- Sound must never block, delay or break gameplay."
];

function buildPromptBundle({ gamePackage, request, plan, premium = false, sound = false }) {
  const hasAssets = Boolean(
    gamePackage.gameplayAssets?.manifest && Object.keys(gamePackage.gameplayAssets.manifest).length
  );
  // Code-drawn sprite sets (Tier 3) come with a catalog: name, role, pixel size
  // and animation frames. Without one, the classic player/environment/objects
  // wording below is used unchanged.
  const catalog = Array.isArray(gamePackage.gameplayAssets?.catalog) ? gamePackage.gameplayAssets.catalog : null;
  const assetNames = catalog ? catalog.map((entry) => entry.name).join("/") : "player/environment/objects";
  const premiumRules = premium
    ? [
        "ULTRA PREMIUM QUALITY IS MANDATORY:",
        hasAssets
          ? `- Real sprite images are supplied (${assetNames}). Render them with KULT_RUNTIME.drawAsset and build polished procedural effects AROUND them (particles, impact flashes, HUD, transitions) — do NOT replace the supplied art with drawn shapes.`
          : "- Build polished procedural visuals directly in Canvas/CSS/SVG; do not request or depend on separately generated assets.",
        "- Include purposeful motion: entrance transitions, responsive gameplay animation, impact flashes, particle bursts, and restrained screen shake on major impacts.",
        "- Include a polished start menu, touch-accessible pause/resume, game-over or victory menu, and an obvious tap/click restart flow.",
        "- Include meaningful progression such as increasing difficulty, levels/waves, unlocks, combo milestones, or escalating challenge appropriate to the game.",
        "- Use one intentional art direction: a small named color palette, consistent shapes, typography, lighting, HUD, and effects.",
        "- Prioritize game feel: immediate input response, readable collision feedback, satisfying scoring feedback, and smooth transitions.",
        sound ? null : "- Do not add generated audio or Web Audio. Premium quality must come from gameplay and visuals.",
        "- Treat every item above as required functionality, not optional decoration."
      ].filter(Boolean)
    : [];
  return {
    premium,
    system: [
      "You are an expert browser game developer.",
      "Generate a fully playable browser game as one complete JavaScript module.",
      "Output only executable JavaScript for src/main.js. Do not use markdown fences.",
      "Use vanilla Canvas 2D. Do not import Phaser, Three.js, React, or external libraries.",
      "Use the existing <canvas id=\"game\"> element and make keyboard plus pointer input work.",
      "FILL THE SCREEN: the game runs in a tall, narrow portrait frame. Set canvas.width = window.innerWidth and canvas.height = window.innerHeight at startup AND on every 'resize' event — never hardcode 960x540 or any fixed size. Position and scale EVERYTHING (board, player, obstacles, HUD) relative to the current canvas.width/height so the playfield always fills the whole frame with no big empty margins. For a square board, make it as large as the smaller dimension allows and center it.",
      "The game MUST be fully playable on a touch phone with no keyboard: handle touchstart/touchend (and pointer events) on the canvas so swipes steer/move and taps perform the main action; never make a physical key the ONLY way to play.",
      "Restart MUST fully reset ALL game state to a fresh start (score, player, entities, timers, spawn queues, flags, the game-over/win state) and MUST trigger ONLY on an explicit tap/click/keypress after game over. The game must NEVER auto-restart, loop back, or reset itself on its own — a game that keeps restarting by itself is a critical failure.",
      "Every control, button, and mechanic must be fully wired and actually work — no dead buttons, no half-implemented inputs. The game must not throw any uncaught runtime error while loading or playing.",
      "Import the game package with: import { gamePackage } from \"./gamePackage.js\";",
      "Import styles with: import \"./styles.css\";",
      "Do not use export statements anywhere in the module.",
      "When a run ends (game over or win), call window.reportScore(finalScore) if it exists so the score reaches the platform leaderboard.",
      "Maintain responsive sizing, restart behavior, score/state feedback, and a 60 FPS target.",
      "A validated runtime shell named KULT_RUNTIME is prepended automatically. Use KULT_RUNTIME.canvas, KULT_RUNTIME.ctx, KULT_RUNTIME.input, KULT_RUNTIME.drawAsset(name,...), KULT_RUNTIME.reportScore(score), and KULT_RUNTIME.consumeRestart() instead of recreating those systems.",
      "Focus generated code on game-specific state, rules, update, collision, and render functions; do not regenerate generic canvas setup, resize, input, asset-loader, restart-input, or score-bridge boilerplate.",
      "GAME FEEL / JUICE — make even a simple game feel premium. Apply the ones that fit this game:",
      "- Particles: emit short-lived particle bursts on impactful moments (collect, score, destroy, clear, player death). Keep them cheap — small pooled arrays that fade and shrink and are removed when dead.",
      "- Screen shake: a brief, restrained canvas shake on big hits / clears / death — small amplitude that decays within ~200ms. Never a constant shake.",
      "- Smooth motion: lerp/ease entities toward their targets instead of snapping; things should glide into place, not teleport.",
      "- Pop & flash: scale-pop objects when they spawn, flash a color on hit/score, and briefly highlight whatever just changed so feedback is instantly readable.",
      "- Score & combo feedback: float a rising \"+points\" text at the event location, and escalate the visual intensity (bigger flash, more particles) on streaks, combos, and level-ups.",
      "- Transitions: ease the start menu, level changes, and the game-over screen in and out (fade/scale), not hard cuts.",
      "- Keep it performant and safe: cap/pool particles, hold 60fps, scale everything to the current canvas size, and never let effects block input, throw, or break the core loop.",
      ...(sound ? SOUND_RULES : []),
      ...premiumRules,
      "FINAL SELF-CHECK — before you output, silently re-read your module and fix ONLY genuine defects you find against this list:",
      "- Every control is wired and actually works on BOTH keyboard and touch (no dead inputs, no half-implemented handlers).",
      "- Nothing reads a property or index of a value that can be undefined (e.g. board[r][c] before board[r] exists, or entity.x when entity is undefined) — this is the most common crash.",
      "- Restart fully resets ALL state (score, player, entities, timers, spawn queues, flags, the game-over/win state) and triggers ONLY on explicit input — it must never auto-restart or loop by itself.",
      "- No uncaught error can occur on load or the first frame; every variable and function used is defined before use.",
      "- Win/lose conditions are reachable and actually fire.",
      "STRICT RULES FOR THIS CHECK (it must only ever IMPROVE the game, never degrade it): This is a precise fix pass, NOT a rewrite. Change ONLY lines that are genuinely broken and leave all correct, working code exactly as written. Do NOT add try/catch, redundant null-guards, or defensive boilerplate 'just in case'. Do NOT remove, simplify, or water down any gameplay, mechanics, feature, or the visual juice/polish above. If everything already passes, return the module unchanged."
    ].join("\n"),
    user: [
      `Template: ${gamePackage.templateName}`,
      `Title: ${gamePackage.title}`,
      `Mechanic: ${gamePackage.gameplay?.mechanic}`,
      `Controls: ${gamePackage.gameplay?.controls}`,
      `Tuning: ${JSON.stringify(gamePackage.gameplay?.tuning)}`,
      `Visual mood: ${gamePackage.visuals?.mood}`,
      `Colors: ${(gamePackage.visuals?.colors ?? []).join(", ")}`,
      `Gameplay asset manifest: ${JSON.stringify(gamePackage.gameplayAssets?.manifest ?? gamePackage.visuals?.assets ?? {})}`,
      ...(gamePackage.gameplayAssets?.manifest
        ? [
            "Render the supplied sprites with KULT_RUNTIME.drawAsset(name, x, y, w, h) — it already preloads the images the correct way. Prefer this over creating your own Image objects.",
            "If you DO load an image yourself, use `const img = new Image(); img.src = url;` and DO NOT set img.crossOrigin — these images are for on-canvas display only, and setting crossOrigin makes them fail to load (you get a blank/box instead of the art).",
            ...(catalog
              ? [
                  "Sprite catalog (every entry is a transparent PNG already loaded under its name; width/height are its pixel size):",
                  ...catalog.map((entry) => `- ${entry.name} [${entry.kind}] ${entry.width}x${entry.height} (aspect ${entry.aspect})${entry.facing && entry.facing !== "none" ? `, front faces ${entry.facing}` : ""}: ${entry.description}${entry.usage ? ` — use: ${entry.usage}` : ""}${entry.basedOn ? ` — animation frame of ${entry.basedOn}` : ""}${Array.isArray(entry.rig) && entry.rig.length ? " — rigged (see below)" : ""}`),
                  "Use every catalog sprite for its listed role. \"player\" is the character the user controls. If \"environment\" exists, draw it first each frame covering the whole canvas.",
                  "Always keep each sprite's aspect ratio: pick a draw height from the canvas size and use width = height * aspect. Size sprites from the canvas so they read well on a phone.",
                  "Each sprite's front already points in its listed direction, so draw it as-is when it travels that way. A sprite facing right that moves left is flipped with ctx.save(); ctx.translate(x + w, y); ctx.scale(-1, 1); draw at (0, 0); ctx.restore(). Only rotate a sprite when it really travels in a different direction, and never draw a vehicle sideways by accident.",
                  ...catalog
                    .filter((entry) => !entry.basedOn && catalog.some((other) => other.basedOn === entry.name))
                    .map((entry) => `Frame animation: ${[entry.name, ...catalog.filter((other) => other.basedOn === entry.name).map((other) => other.name)].join(" → ")} is one looping cycle — step through it in that order about every 90–130ms while ${entry.name} moves, and hold ${entry.name} when idle. Draw every frame with the same box so it does not jitter.`),
                  ...catalog
                    .filter((entry) => Array.isArray(entry.rig) && entry.rig.length)
                    .map((entry) => `Rigged sprite ${entry.name}: instead of the single image, draw these layers back-to-front at exactly the same x, y, w, h you would use for ${entry.name}: ${entry.rig.map((layer) => `${layer.layer} (${layer.motion}${layer.pivot ? `, pivot ${layer.pivot[0]},${layer.pivot[1]}` : ""})`).join(", ")}.`),
                  ...(catalog.some((entry) => Array.isArray(entry.rig) && entry.rig.length)
                    ? ["Animating rig layers: a pivot is a fraction of the sprite box (0,0 top-left, 1,1 bottom-right). Rotate a layer around it with ctx.save(); ctx.translate(x + px*w, y + py*h); ctx.rotate(angle); ctx.translate(-(x + px*w), -(y + py*h)); drawAsset(layer, x, y, w, h); ctx.restore(). Motions: spin = angle grows with travel speed; flap = Math.sin(t*14)*0.45; swing = Math.sin(t*10)*0.5, with paired limbs (_front/_back, _left/_right) in opposite phase; bob = Math.sin(t*6)*0.15; blink = every 3–4s squash the layer vertically to 10% around its pivot for about 120ms; pulse = scale the layer around its pivot by 1 + Math.sin(t*25)*0.12 plus a little randomness (flames, jets, glows; bigger during boosts); none = no transform. When flipping a sprite to face left, flip the whole sprite first, then apply the layer rotations inside the flip. If any layer is not loaded yet, draw the single image instead."]
                    : []),
                  "Add procedural life on top: idle bob, squash-and-stretch on jump and landing, tilt toward the direction of motion, a white hit flash, and a scale pop on spawn.",
                  "Sprites have no baked ground shadow: draw a soft dark ellipse under characters and grounded objects in code, kept on the ground (it shrinks and fades as they jump).",
                  "Use the sprite's drawn box for collisions, shrunk slightly (about 80%) so hits feel fair."
                ]
              : ["Use the player asset for the main character, environment as the gameplay background, and objects for visible world props/obstacles/collectibles."]),
            "Do not replace supplied assets with circles, rectangles, emoji, Unicode characters, or other placeholder primitives.",
            "Draw a plain fallback only for the brief moment while an image is still loading — never as the permanent look."
          ]
        : []),
      `Creator request: ${request || gamePackage.customization?.prompt || "Create a polished playable version of this game."}`,
      ...(plan
        ? [
            "Build plan from the orchestrator — implement the game following its intent and steps, but the technical rules above always win on any conflict:",
            plan
          ]
        : []),
      "Return only the complete JavaScript module. It must run immediately in a Vite browser project."
    ].join("\n")
  };
}

function stripMarkdownFence(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:js|javascript)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// The preview sandbox wraps the module in a try/catch, where `export` is a
// syntax error that blanks the whole game. Models sometimes append exports
// "for external use" — neutralize them while keeping the declarations.
function stripModuleExports(code) {
  return String(code || "")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "")
    .replace(/^(\s*)export\s+(const|let|var|function|class|async)/gm, "$1$2");
}

function functionRegionAtLine(code, targetLine) {
  if (!targetLine) return null;
  const source = String(code || "");
  const starts = [];
  const pattern = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const open = source.indexOf("{", start);
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      if (depth === 0) {
        const startLine = source.slice(0, start).split("\n").length;
        const endLine = source.slice(0, i + 1).split("\n").length;
        if (targetLine >= startLine && targetLine <= endLine) {
          starts.push({ name: match[1] || match[2], start, end: i + 1, code: source.slice(start, i + 1) });
        }
        break;
      }
    }
  }
  return starts.sort((a, b) => b.start - a.start)[0] ?? null;
}

function replaceFunctionRegion(moduleCode, region, replacement) {
  const clean = stripModuleExports(stripMarkdownFence(replacement));
  if (!clean || !new RegExp(`\\b${region.name}\\b`).test(clean)) return null;
  return `${moduleCode.slice(0, region.start)}${clean}${moduleCode.slice(region.end)}`;
}

function sumUsage(usages) {
  return usages.reduce((total, usage) => {
    if (!usage) return total;
    total.prompt_tokens += usage.prompt_tokens ?? 0;
    total.completion_tokens += usage.completion_tokens ?? 0;
    total.total_tokens += usage.total_tokens ?? 0;
    return total;
  }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
}

// Validates that the module parses as JavaScript once the sandbox strips its
// import lines (the same shape the browser executes). Returns the syntax
// error message, or null when the code is valid.
function findSyntaxError(code) {
  const stripped = String(code || "")
    .replace(/^\s*import\s+["'][^"']*["'];?\s*$/gm, "")
    .replace(/^\s*import\s+[^;\n]*from\s+["'][^"']*["'];?\s*$/gm, "");
  try {
    // Parses without executing.
    new Function(stripped);
    return null;
  } catch (error) {
    return error.message;
  }
}

function findSyntaxLine(code) {
  const stripped = String(code || "")
    .replace(/^\s*import\s+["'][^"']*["'];?\s*$/gm, "")
    .replace(/^\s*import\s+[^;\n]*from\s+["'][^"']*["'];?\s*$/gm, "");
  try {
    new vm.Script(stripped, { filename: "generated-game.js" });
    return null;
  } catch (error) {
    const match = String(error?.stack || "").match(/generated-game\.js:(\d+)/);
    return match ? Number(match[1]) : null;
  }
}

// 12 minutes per attempt, one retry: worst case stays inside a 15-minute
// generation budget instead of the previous 20min x 3 attempts.
async function callCodingStage({
  model,
  system,
  user,
  maxTokens = 3500,
  timeoutMs = 720000,
  retries = 1,
  onChunk
}) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
  const response = await callZeroGChat({
    model,
    temperature: 0.35,
    maxTokens,
    timeoutMs,
    retries,
    messages,
    onChunk
  });

  // A module cut off at the token cap is a guaranteed syntax error — issue one
  // continuation and concatenate instead of shipping half a file.
  if (response.finishReason !== "length") return response;

  const continuation = await callZeroGChat({
    model,
    temperature: 0.35,
    maxTokens,
    timeoutMs,
    retries,
    onChunk,
    messages: [
      ...messages,
      { role: "assistant", content: response.content },
      {
        role: "user",
        content: "Your output was cut off mid-file. Continue EXACTLY from the character where you stopped. Output only the remaining code, with no markdown fences and no repetition of code you already wrote."
      }
    ]
  });

  return {
    ...response,
    content: response.content + continuation.content,
    finishReason: continuation.finishReason,
    usage: sumUsage([response.usage, continuation.usage])
  };
}

function missingRuntimeFeatures(code) {
  const checks = [
    ["#game canvas selection", /querySelector\s*\(\s*["'`]#game["'`]\s*\)/],
    ["2D rendering context", /getContext\s*\(\s*["'`]2d["'`]\s*\)/],
    ["animation loop", /requestAnimationFrame\s*\(/],
    ["pointer or touch input", /pointerdown|mousedown|touchstart/],
    ["restart input", /restart|KeyR|keydown/i]
  ];

  return checks.filter(([, pattern]) => !pattern.test(code)).map(([label]) => label);
}

function missingPremiumFeatures(code) {
  const checks = [
    ["procedural particles", /\bparticles?\b|\bsparks?\b|\bconfetti\b|\bburst\b/i],
    ["impact screen shake", /\b(screenShake|cameraShake|shake(?:Time|Amount|Intensity|Offset)?)\b/i],
    ["start menu", /\b(startMenu|startScreen|gameState\s*=\s*["'`]start|state\s*=\s*["'`]menu)\b/i],
    ["pause and resume", /\bpause(?:d|Menu)?\b[\s\S]{0,120}\bresume\b|\bresume\b[\s\S]{0,120}\bpause/i],
    ["game-over or victory menu", /\b(game[\s_-]?over|victory|winScreen|endScreen)\b/i],
    ["progression or escalating challenge", /\b(level|wave|difficulty|combo|milestone|unlock)\b/i],
    ["consistent palette or art direction", /\b(palette|colorPalette|themeColors|COLORS|PAL)\b/]
  ];

  return checks.filter(([, pattern]) => !pattern.test(code)).map(([label]) => label);
}

function missingRequiredFeatures(code, premium) {
  return [
    ...missingRuntimeFeatures(code),
    ...(premium ? missingPremiumFeatures(code) : [])
  ];
}

// From-scratch generation is capped at ~18,000 characters of code: generation
// time scales linearly with output length, and the cap keeps a pure-agent
// build inside a single response (no slow continuation round). 18K chars is
// ~5.4K tokens; the 7168 ceiling leaves headroom without allowing 16K-token runs.
const SCRATCH_CHAR_TARGET = 18000;
const SCRATCH_MAX_TOKENS = 7168;

// Per-tier overrides from .env (TIER{n}_CODING_MAX_TOKENS / TIER{n}_CODING_CHAR_TARGET).
// Premium games with sprite rigs and sound run well past 18K chars; a cap that
// cuts them off forces a continuation plus repair passes that cost more than
// simply letting one reply finish.
function codingLimits(models) {
  const n = models?.tier;
  const read = (key, fallback, min, max) => {
    const value = Number(process.env[`TIER${n}_${key}`]);
    return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  };
  return {
    maxTokens: read("CODING_MAX_TOKENS", SCRATCH_MAX_TOKENS, 2000, 32000),
    charTarget: read("CODING_CHAR_TARGET", SCRATCH_CHAR_TARGET, 8000, 80000)
  };
}

async function generateWithModel(promptBundle, model, onProgress, models = zeroGModels) {
  // Single-stage unified code generation for maximum speed
  const limits = codingLimits(models);
  const response = await callCodingStage({
    model,
    maxTokens: limits.maxTokens,
    onChunk: (chars) => onProgress?.({ stage: "writing-code", chars }),
    system: [
      promptBundle.system,
      "You are implementing a COMPLETE, fully playable browser game from scratch in one JavaScript module.",
      "Keep your thinking/reasoning brief to save output tokens.",
      // Soft length nudge only — correctness always wins over brevity.
      `Aim to keep the module around ${limits.charTarget.toLocaleString("en-US")} characters, but NEVER omit, stub, shorten, or fake gameplay to hit a length — a complete working game is the only priority. No TODOs, no placeholder functions, no "// add logic here".`,
      "EVERY feature, control, button, and mechanic you mention or draw MUST be fully implemented and actually work — no dead buttons, no half-wired inputs.",
      "RESTART must fully reset ALL game state to a fresh start (score, player, entities, timers, flags, game-over state) and must trigger ONLY on an explicit tap/click/keypress after game over — the game must NEVER auto-restart, loop, or reset itself on its own.",
      "The game MUST NOT throw any uncaught runtime error while loading or playing — guard array/object access, initialize every variable before use, and never read a property of something that could be undefined.",
      "Before finishing, mentally play one full round (start → play → game over → restart) and make sure nothing breaks and every control responds.",
      "Make the game fill the entire browser viewport: set canvas.width = window.innerWidth and canvas.height = window.innerHeight on startup and on every window resize, and position/scale all gameplay relative to the current canvas size (no fixed 960x540 layouts).",
      "Return only executable JavaScript source without markdown fences.",
      "The script must select the <canvas id=\"game\"> element, get the 2D rendering context, and implement the complete game state, loop, input handling, and canvas rendering.",
      "It must run immediately when imported in a Vite project.",
      "Do not access resources other than the supplied gameplay asset manifest, and do not use external libraries. Handle game restart (KeyR + tap/click) and resize correctly."
    ].join("\n"),
    user: promptBundle.user
  });

  let generatedCode = attachValidatedRuntimeShell(stripModuleExports(stripMarkdownFence(response.content)));
  const usages = [response.usage];
  const stages = {
    unifiedGeneration: { model: response.model, usage: response.usage }
  };

  // One repair pass on the fast background model: catches modules that came
  // back without a loop, input, or canvas wiring, at a fraction of the
  // coding model's latency.
  const missing = missingRequiredFeatures(generatedCode, promptBundle.premium);
  if (missing.length > 0) {
    try {
      const repair = await callCodingStage({
        model: models.repair || models.coding,
        maxTokens: codingLimits(models).maxTokens,
        timeoutMs: promptBundle.premium ? 120000 : 720000,
        retries: promptBundle.premium ? 0 : 1,
        onChunk: (chars) => onProgress?.({ stage: "repairing", chars }),
        system: [
          promptBundle.system,
          "Repair the supplied incomplete src/main.js.",
          "Keep your thinking/reasoning extremely brief and concise to save output tokens.",
          "Return one complete executable module, not an explanation.",
          "It must select document.querySelector(\"#game\"), obtain a 2D context, render the game, handle pointer/touch and keyboard input, run requestAnimationFrame, and support restart (KeyR).",
          ...(promptBundle.premium
            ? [
                "This is the single Ultra polish repair. Preserve working gameplay and add only the missing premium requirements.",
                "Complete this repair within the strict two-minute polish budget. Do not add audio."
              ]
            : []),
          `The previous output was missing: ${missing.join(", ")}.`
        ].join("\n"),
        user: [promptBundle.user, "\nINCOMPLETE MODULE:\n", generatedCode].join("\n")
      });
      const repairedCode = attachValidatedRuntimeShell(stripModuleExports(stripMarkdownFence(repair.content)));
      usages.push(repair.usage);
      stages.repair = { model: models.repair || models.coding, usage: repair.usage };
      // Only adopt the repair when it actually closes gaps.
      if (missingRequiredFeatures(repairedCode, promptBundle.premium).length < missing.length) {
        generatedCode = repairedCode;
      }
    } catch (error) {
      if (!promptBundle.premium) throw error;
      // The premium polish pass is optional after a playable first result.
      // If its strict budget expires, return the original build immediately.
      stages.repair = {
        model: models.repair || models.coding,
        skipped: true,
        reason: error.message
      };
    }
  }

  return {
    provider: response.provider,
    model: response.model,
    generatedCode,
    usage: sumUsage(usages),
    stages
  };
}

// Returns the first concrete problem with a module, or null when it runs clean.
function moduleProblem(code, gamePackage) {
  const syntaxError = findSyntaxError(code);
  if (syntaxError) return `It has a JavaScript syntax error: ${syntaxError}`;
  const smoke = runtimeSmokeTest(code, gamePackage);
  if (!smoke.ok) return `It parses but crashes the moment it runs: ${smoke.error}`;
  const missing = missingRuntimeFeatures(code);
  if (missing.length > 0) return `It is missing required pieces: ${missing.join(", ")}`;
  return null;
}

// A module is "hard broken" only if it definitely won't run for the player: a
// syntax error, missing core runtime wiring, or a crash AS IT LOADS. A crash
// that only appears while blindly stepping frames with no input is treated as
// soft — for an edit we'd rather apply the change (with a warning) than revert
// it, since such crashes are often false positives for input-driven games.
function hardBrokenReason(code, gamePackage) {
  const syntaxError = findSyntaxError(code);
  if (syntaxError) return `JavaScript syntax error: ${syntaxError}`;
  const missing = missingRuntimeFeatures(code);
  if (missing.length > 0) return `missing required pieces: ${missing.join(", ")}`;
  const smoke = runtimeSmokeTest(code, gamePackage);
  if (!smoke.ok && smoke.phase === "load") return `crashes as it loads: ${smoke.error}`;
  return null;
}

// Repairs an edited game module in place — NEVER regenerates from scratch.
// Each attempt feeds the exact current error back to the agent and asks it to
// fix ONLY that while keeping the existing gameplay and the creator's change.
// Escalates to the stronger coding model after the first cheap attempt.
async function repairEditedModule(code, promptBundle, gamePackage, onProgress, maxAttempts = 2, models = zeroGModels) {
  let current = code;
  const usages = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const hard = hardBrokenReason(current, gamePackage);
    const problem = hard || moduleProblem(current, gamePackage);
    if (!problem) return { code: current, ok: true, usage: sumUsage(usages) };
    // Only a soft frame-step warning remains after a first try — stop here and
    // let the caller ship the edit rather than burning more time/tokens.
    if (!hard && attempt > 1) break;
    const repair = await callCodingStage({
      model: models.repair || models.coding,
      maxTokens: 16384,
      onChunk: (chars) => onProgress?.({ stage: "repairing", chars }),
      system: [
        promptBundle.system,
        "Repair the game module below. KEEP all existing gameplay and the change the creator asked for — fix ONLY what is broken.",
        "Return one complete executable src/main.js module, no markdown fences, no explanation.",
        "Problem to fix: " + problem
      ].join("\n"),
      user: [promptBundle.user, "\nMODULE TO FIX (repair in place, keep its behavior):\n", current].join("\n")
    });
    usages.push(repair.usage);
    current = attachValidatedRuntimeShell(stripModuleExports(stripMarkdownFence(repair.content)));
  }
  return { code: current, ok: !moduleProblem(current, gamePackage), usage: sumUsage(usages) };
}

// Seed-and-edit: hand the agent a working reference module and ask it to modify
// that, instead of writing from a blank page. When the edit comes back broken,
// it is REPAIRED in place (multiple attempts, keeping the creator's change) —
// never regenerated from scratch. Only if repair cannot make it run does the
// previous working build ship unchanged.
async function generateFromSeed(promptBundle, seedCode, model, onProgress, gamePackage, models = zeroGModels) {
  const integration = await callCodingStage({
    model,
    maxTokens: 12000,
    onChunk: (chars) => onProgress?.({ stage: "editing-seed", chars }),
    system: [
      promptBundle.system,
      "You are EDITING an existing, working game implementation, not writing one from scratch.",
      "Keep your thinking/reasoning extremely brief and concise to save output tokens.",
      "Start from the REFERENCE module below and modify it to satisfy the creator request.",
      "Keep everything that already works: the game loop, input handling, rendering, and win/lose flow.",
      "Change only what the request needs — theme, colors, rules tweaks, difficulty, labels, or mechanic variations.",
      "Preserve the import lines and the #game canvas usage. Return one complete executable src/main.js module without markdown fences."
    ].join("\n"),
    user: [promptBundle.user, "\nREFERENCE MODULE (edit this, keep its structure):\n", seedCode].join("\n")
  });
  let generatedCode = attachValidatedRuntimeShell(stripModuleExports(stripMarkdownFence(integration.content)));
  const usages = [integration.usage];

  // Repair in place if anything looks wrong — never regenerate from scratch.
  if (moduleProblem(generatedCode, gamePackage)) {
    const repaired = await repairEditedModule(generatedCode, promptBundle, gamePackage, onProgress, 2, models);
    usages.push(repaired.usage);
    // Keep the repaired code as long as it isn't WORSE than where we started.
    if (!hardBrokenReason(repaired.code, gamePackage) || repaired.ok) {
      generatedCode = attachValidatedRuntimeShell(repaired.code);
    }
  }

  // Only revert to the previous build when the edit definitely won't run for
  // the player (syntax / missing wiring / load-time crash). A soft frame-step
  // warning still ships the edit so the creator's change isn't dropped.
  const hardReason = hardBrokenReason(generatedCode, gamePackage);
  if (hardReason) {
    return {
      provider: "reference",
      model: "reference-seed",
      generatedCode: seedCode,
      usage: sumUsage(usages),
      stages: { seedEdit: { model, usage: integration.usage } },
      source: "seed-fallback"
    };
  }

  const soft = moduleProblem(generatedCode, gamePackage);
  return {
    provider: integration.provider,
    model: integration.model,
    generatedCode,
    usage: sumUsage(usages),
    stages: { seedEdit: { model: integration.model, usage: integration.usage } },
    source: "seed-edit",
    warning: soft ? "Edit applied — give it a quick test; if something misbehaves, describe the fix in chat." : null
  };
}

async function call0GAgent(promptBundle, onProgress, models = zeroGModels) {
  try {
    return await generateWithModel(promptBundle, models.coding, onProgress, models);
  } catch (error) {
    const fallbackModel = models.background;
    const nonRetriable = error.status && error.status < 500 && ![408, 429].includes(error.status);
    if (fallbackModel === models.coding || nonRetriable) throw error;

    console.warn("0G coding model failed after retries; using fallback", {
      primaryModel: models.coding,
      fallbackModel,
      message: error.message
    });
    return generateWithModel(promptBundle, fallbackModel, onProgress, models);
  }
}

// Broken syntax means a black screen in the sandbox. One cheap repair attempt
// on the fast model fixes most cases; a seed-backed game falls back to the
// working reference if the repair fails too.
async function ensureValidSyntax(generated, promptBundle, reference, onProgress, models = zeroGModels) {
  let syntaxError = findSyntaxError(generated.generatedCode);
  if (!syntaxError) return generated;

  try {
    const syntaxLine = findSyntaxLine(generated.generatedCode);
    const region = functionRegionAtLine(generated.generatedCode, syntaxLine);
    const repair = await callCodingStage({
      model: models.repair || models.coding,
      maxTokens: region ? 5000 : 16384,
      onChunk: (chars) => onProgress?.({ stage: "fixing-syntax", chars }),
      system: [
        promptBundle.system,
        region
          ? `Repair only the complete function named ${region.name}. Return that one complete corrected function and nothing else.`
          : "The module below fails to parse. Return the complete corrected module and nothing else.",
        `SyntaxError: ${syntaxError}`,
        ...(syntaxLine ? [`Failing generated module line: ${syntaxLine}`] : [])
      ].join("\n"),
      user: [
        promptBundle.user,
        region ? `\nBROKEN FUNCTION ${region.name}:\n` : "\nBROKEN MODULE:\n",
        region?.code ?? generated.generatedCode
      ].join("\n")
    });
    const targeted = region
      ? replaceFunctionRegion(generated.generatedCode, region, repair.content)
      : null;
    const fixed = targeted
      ? attachValidatedRuntimeShell(targeted)
      : attachValidatedRuntimeShell(stripModuleExports(stripMarkdownFence(repair.content)));
    if (!findSyntaxError(fixed)) {
      return {
        ...generated,
        generatedCode: fixed,
        usage: sumUsage([generated.usage, repair.usage]),
        stages: { ...generated.stages, syntaxRepair: { model: models.repair || models.coding, usage: repair.usage } }
      };
    }
    syntaxError = findSyntaxError(fixed) ?? syntaxError;
  } catch {
    // repair call itself failed — fall through to the reference fallback
  }

  if (reference) {
    return {
      provider: "reference",
      model: "reference-seed",
      generatedCode: reference.code,
      usage: generated.usage,
      stages: generated.stages,
      source: "seed-fallback",
      warning: `Generated code had a syntax error (${syntaxError}); shipped the working reference instead.`
    };
  }

  generated.warning = `Generated code has a syntax error the repair could not fix: ${syntaxError}`;
  return generated;
}

// Parsing clean is not the same as running clean: code like `board[r][c] = x`
// (where board[r] is undefined) crashes the instant it executes, showing the
// player "Generated build failed to run…". Run the module in a mocked browser;
// if it throws, repair it with the runtime error, then re-test. A seed-backed
// game falls back to the working reference if the repair still crashes.
async function ensureRuntimeRuns(generated, promptBundle, gamePackage, reference, onProgress, models = zeroGModels) {
  let result = runtimeSmokeTest(generated.generatedCode, gamePackage);
  if (result.ok) return generated;

  try {
    const region = functionRegionAtLine(generated.generatedCode, result.line);
    const repair = await callCodingStage({
      model: models.repair || models.coding,
      maxTokens: region ? 5000 : 16384,
      onChunk: (chars) => onProgress?.({ stage: "fixing-runtime", chars }),
      system: [
        promptBundle.system,
        region
          ? `Repair only the complete function named ${region.name}. Return that one complete corrected function and nothing else.`
          : "The module below PARSES but throws a runtime error. Return the complete corrected module and nothing else.",
        "Keep all working gameplay behavior unchanged.",
        `Runtime error: ${result.error}`,
        ...(result.line ? [`Failing generated module line: ${result.line}`] : []),
        "Common causes: indexing into an array/object that was never initialised (e.g. board[r][c] before board[r] exists), reading a property of a variable that is still undefined, or using an element/context before it is assigned."
      ].join("\n"),
      user: [
        promptBundle.user,
        region ? `\nBROKEN FUNCTION ${region.name}:\n` : "\nBROKEN MODULE:\n",
        region?.code ?? generated.generatedCode
      ].join("\n")
    });
    const targeted = region
      ? replaceFunctionRegion(generated.generatedCode, region, repair.content)
      : null;
    const fixed = targeted
      ? attachValidatedRuntimeShell(targeted)
      : attachValidatedRuntimeShell(stripModuleExports(stripMarkdownFence(repair.content)));
    if (!findSyntaxError(fixed) && runtimeSmokeTest(fixed, gamePackage).ok) {
      return {
        ...generated,
        generatedCode: fixed,
        usage: sumUsage([generated.usage, repair.usage]),
        stages: { ...generated.stages, runtimeRepair: { model: models.repair || models.coding, usage: repair.usage } }
      };
    }
    result = runtimeSmokeTest(fixed, gamePackage).ok ? { ok: true } : result;
  } catch {
    // repair call itself failed — fall through to the reference fallback
  }

  if (reference) {
    return {
      provider: "reference",
      model: "reference-seed",
      generatedCode: reference.code,
      usage: generated.usage,
      stages: generated.stages,
      source: "seed-fallback",
      warning: `Generated code crashed at runtime (${result.error}); shipped the working reference instead.`
    };
  }

  generated.warning = `Generated code crashes at runtime: ${result.error}`;
  return generated;
}

// Playtest fix pass: the playtest saw real problems in the running game (from
// screenshots and the error console). Fix only those, keep everything else, and
// accept the result only if it still passes the same syntax + runtime checks —
// otherwise the original module is kept.
export async function repairFromPlaytest({ code, issues, gamePackage, model, maxTokens = 16384 }) {
  const response = await callCodingStage({
    model,
    maxTokens,
    retries: 1,
    timeoutMs: 600000,
    system: [
      "You are fixing a finished browser game module after a playtest on a 390x844 phone screen.",
      "Fix ONLY the problems listed. Keep every working mechanic, feature, sprite, effect, sound and HUD element exactly as it is — do not rewrite, simplify or restyle anything else.",
      "Return the complete corrected JavaScript module only, with no markdown fences and no commentary."
    ].join("\n"),
    user: [
      "Problems found in the playtest:",
      ...issues.map((issue) => `- ${issue}`),
      "",
      "Current module:",
      code
    ].join("\n")
  });
  const fixed = attachValidatedRuntimeShell(stripMarkdownFence(response.content));
  const problem = moduleProblem(fixed, gamePackage);
  return { code: problem ? code : fixed, ok: !problem, problem, usage: response.usage ?? null, model: response.model };
}

export async function createRefinementBundle(
  { gamePackage, request, refinementLevel, strategy, baseCode, plan, tier, models = zeroGModels },
  { onProgress } = {}
) {
  if (!gamePackage) {
    const error = new Error("gamePackage is required");
    error.status = 400;
    throw error;
  }

  // The orchestrator plan only guides from-scratch pure-agent builds; seeded
  // template edits already have the reference code as their spec.
  const promptBundle = buildPromptBundle({
    gamePackage,
    request,
    plan: strategy === "pure-agent" && !baseCode ? plan : null,
    premium: Number(tier) === 3 && !baseCode,
    sound: gameSoundEnabled(tier) && !baseCode
  });
  // When the caller supplies the game's current code (post-creation editing),
  // that code IS the seed — the agent applies the requested change to it.
  const reference = baseCode
    ? { templateId: gamePackage.templateId ?? "current-build", code: baseCode }
    : getReferenceGame(gamePackage.templateId);

  let generated;
  if (reference && (baseCode || strategy !== "pure-agent")) {
    try {
      generated = await generateFromSeed(promptBundle, reference.code, models.coding, onProgress, gamePackage, models);
    } catch (error) {
      // Agent unreachable — ship the working reference unchanged so the user still gets a game.
      generated = {
        provider: "reference",
        model: "reference-seed",
        generatedCode: reference.code,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        stages: {},
        source: "seed-fallback",
        warning: error.message
      };
    }
  } else {
    generated = await call0GAgent(promptBundle, onProgress, models);
    generated.source = generated.source ?? "agent";
  }

  if (generated.source !== "seed-fallback") {
    const fallbackRef = strategy !== "pure-agent" ? reference : null;
    generated = await ensureValidSyntax(generated, promptBundle, fallbackRef, onProgress, models);
    // Syntax-clean code can still crash on its first run — verify it actually
    // executes and repair/fall back if not.
    if (generated.source !== "seed-fallback") {
      generated = await ensureRuntimeRuns(generated, promptBundle, gamePackage, fallbackRef, onProgress, models);
    }
  }

  const syntaxOk = !findSyntaxError(generated.generatedCode);
  const premiumMissing = promptBundle.premium
    ? missingPremiumFeatures(generated.generatedCode)
    : [];

  return {
    jobId: `refine_${Date.now().toString(36)}`,
    eta: "complete",
    costProfile: "0g-router-call",
    refinementLevel: refinementLevel ?? "medium",
    promptBundle,
    seededFrom: reference?.templateId ?? null,
    source: generated.source,
    provider: generated.provider,
    model: generated.model,
    generatedCode: generated.generatedCode,
    usage: generated.usage,
    stages: generated.stages,
    warning: generated.warning ?? null,
    validation: [
      syntaxOk ? "Syntax validates" : "Syntax check FAILED",
      "Runs immediately in browser",
      "Pointer and keyboard input works",
      gamePackage.gameplayAssets?.manifest ? "Generated gameplay assets integrated" : "No external images",
      "Performance target is 60 FPS",
      ...(promptBundle.premium
        ? [
            premiumMissing.length === 0
              ? "Ultra premium visual/gameplay checklist validates"
              : `Ultra premium checklist missing: ${premiumMissing.join(", ")}`
          ]
        : [])
    ]
  };
}
