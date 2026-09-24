import { templates, themePresets } from "../data/templates.js";
import { createGamePackage } from "./gameFactoryService.js";
import { createRefinementBundle } from "./refinementService.js";
import { createGenerationLogger } from "../utils/generationLogger.js";
import { createOrchestrationPlan, generateImageAsset, runBackgroundTask, getModelsForTier, getTierStrategy, normalizeTier, zeroGModels } from "./zeroGService.js";
import { generateGameplayAssets } from "./gameplayAssetService.js";
import { getPlaytestConfig, runPlaytest } from "./playtestService.js";
import { nanoid } from "nanoid";

const defaultOptions = {
  theme: null,
  difficulty: "normal",
  customization: "medium",
  extra: "none"
};

// Infers a theme from the user's prompt instead of always defaulting to "neon".
// Returns one of the known theme-preset keys, or null when the prompt doesn't
// clearly imply a theme (callers then avoid forcing a theme label/prefix).
const THEME_KEYWORDS = {
  space: ["space", "galaxy", "star", "planet", "cosmic", "alien", "astronaut", "sci-fi", "scifi", "nebula", "orbit", "spaceship", "ufo", "rocket", "mars", "meteor", "asteroid"],
  fantasy: ["fantasy", "magic", "wizard", "dragon", "knight", "castle", "medieval", "elf", "sword", "dungeon", "kingdom", "goblin", "sorcerer", "potion", "quest", "mythic", "fairy", "witch"],
  nature: ["forest", "jungle", "ocean", "sea", "animal", "garden", "tree", "farm", "fruit", "nature", "safari", "flower", "beach", "island", "wildlife", "mountain", "river", "fish", "bird", "candy"],
  retro: ["retro", "pixel", "8-bit", "8bit", "arcade", "vintage", "classic", "old-school", "oldschool", "chiptune"],
  neon: ["neon", "cyber", "cyberpunk", "glow", "hologram", "futuristic", "techno", "synthwave"]
};

function inferThemeFromPrompt(prompt) {
  const text = String(prompt || "").toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [theme, words] of Object.entries(THEME_KEYWORDS)) {
    const score = words.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
    if (score > bestScore) {
      best = theme;
      bestScore = score;
    }
  }
  return best; // null when nothing in the prompt implies a theme
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function scoreTemplate(prompt, template) {
  const promptTokens = new Set(tokenize(prompt));
  const searchable = [
    template.id,
    template.name,
    template.category,
    template.mechanic,
    template.controls,
    template.assets
  ].join(" ");
  const templateTokens = tokenize(searchable);

  return templateTokens.reduce((score, token) => score + (promptTokens.has(token) ? 1 : 0), 0);
}

function localTemplateSelection(prompt) {
  const ranked = templates
    .map(template => ({ template, score: scoreTemplate(prompt, template) }))
    .sort((a, b) => b.score - a.score);
  const selected = ranked[0]?.template ?? templates[0];

  return {
    templateId: selected.id,
    theme: defaultOptions.theme,
    difficulty: defaultOptions.difficulty,
    customization: defaultOptions.customization,
    extra: defaultOptions.extra,
    reason: ranked[0]?.score > 0 ? "Matched prompt keywords to template metadata." : "Defaulted to strongest starter template."
  };
}

function extractJsonObject(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeSelection(selection, prompt) {
  const fallback = localTemplateSelection(prompt);
  const templateId = templates.some(template => template.id === selection?.templateId)
    ? selection.templateId
    : fallback.templateId;
  const theme = themePresets[selection?.theme]
    ? selection.theme
    : (inferThemeFromPrompt(prompt) ?? fallback.theme);
  const difficulty = ["easy", "normal", "hard", "insane"].includes(selection?.difficulty)
    ? selection.difficulty
    : fallback.difficulty;
  const customization = ["light", "medium", "heavy"].includes(selection?.customization)
    ? selection.customization
    : fallback.customization;
  const extra = ["none", "powerups", "leaderboard", "boss"].includes(selection?.extra)
    ? selection.extra
    : fallback.extra;

  return {
    templateId,
    theme,
    difficulty,
    customization,
    extra,
    reason: selection?.reason || fallback.reason
  };
}

// One background call does both routing and variation design — the previous
// two sequential round-trips added 20-40s of latency and a second failure point.
async function routeAndVaryWithAgent({
  prompt,
  context,
  generationId,
  models = zeroGModels,
  timeoutMs = 10 * 60 * 1000,
}) {
  const localRecommendation = localTemplateSelection(prompt);
  const templateSummaries = templates.map(template => ({
    id: template.id,
    name: template.name,
    category: template.category,
    mechanic: template.mechanic,
    controls: template.controls,
    assets: template.assets,
    engine: template.engine ?? "threejs"
  }));

  const result = await runBackgroundTask({
    task: [
      "Do two jobs in one response.",
      "1) Choose the best game template and configuration for the prompt.",
      "2) Create a distinct variation blueprint built on that template: preserve its reliable core loop, but change multiple meaningful details so repeat generations are not identical.",
      "Return ONLY JSON shaped as:",
      '{ "selection": { "templateId", "theme", "difficulty", "customization", "extra", "reason" },',
      '"variation": { "title", "mechanicTwist", "behaviorChanges" (array), "tuningOverrides" (object of numeric/boolean values), "visualMood", "colors" (3-5 hex colors), "assetDirection", "scoringVariation", "thumbnailConcept", "uniquenessSummary" } }'
    ].join(" "),
    input: {
      prompt,
      generationId,
      context: context ?? null,
      localRecommendation,
      selectionRule:
        "Choose the template whose core player actions and game loop are closest to the request. Prefer mechanic fit over theme or title words.",
      allowedThemes: Object.keys(themePresets),
      allowedDifficulties: ["easy", "normal", "hard", "insane"],
      allowedCustomization: ["light", "medium", "heavy"],
      allowedExtra: ["none", "powerups", "leaderboard", "boss"],
      templates: templateSummaries,
      recentCreations: context?.recentCreations ?? [],
      instruction:
        "Avoid titles, color palettes, tuning combinations, obstacle patterns, scoring rules, and thumbnail compositions used by recentCreations."
    },
    models,
    timeoutMs,
  });

  const parsed = extractJsonObject(result.content) ?? {};
  return {
    agent: result,
    selection: normalizeSelection(parsed.selection, prompt),
    rawVariation: parsed.variation ?? null
  };
}

function normalizeVariation(parsed, { prompt, template, generationId }) {
  parsed = parsed && typeof parsed === "object" ? parsed : {};
  return {
    title: parsed.title || `${template.name} ${generationId.slice(-4).toUpperCase()}`,
    mechanicTwist:
      parsed.mechanicTwist || `A distinct ${prompt} variation of ${template.mechanic}`,
    behaviorChanges: Array.isArray(parsed.behaviorChanges)
      ? parsed.behaviorChanges.slice(0, 8)
      : ["Altered pacing", "Remixed obstacle timing", "Distinct scoring cadence"],
    tuningOverrides:
      parsed.tuningOverrides && typeof parsed.tuningOverrides === "object"
        ? parsed.tuningOverrides
        : {},
    visualMood: parsed.visualMood || "distinctive high-energy game world",
    colors:
      Array.isArray(parsed.colors) && parsed.colors.length >= 3
        ? parsed.colors.slice(0, 5)
        : null,
    assetDirection: parsed.assetDirection || template.assets,
    scoringVariation: parsed.scoringVariation || "Reward skill streaks and clean play",
    thumbnailConcept:
      parsed.thumbnailConcept ||
      `A unique action moment from ${template.name}, generation ${generationId}`,
    uniquenessSummary:
      parsed.uniquenessSummary || "Unique tuning, art direction, and scoring variation"
  };
}

function applyHybridVariation(game, variation, generationId) {
  const safeOverrides = Object.fromEntries(
    Object.entries(variation.tuningOverrides ?? {}).filter(
      ([, value]) => typeof value === "number" || typeof value === "boolean",
    ),
  );

  game.title = variation.title;
  game.gameplay.mechanic = variation.mechanicTwist;
  game.gameplay.tuning = {
    ...game.gameplay.tuning,
    ...safeOverrides,
  };
  game.gameplay.scoring = variation.scoringVariation;
  game.gameplay.behaviorChanges = variation.behaviorChanges;
  game.visuals.mood = variation.visualMood;
  if (variation.colors) game.visuals.colors = variation.colors;
  game.visuals.assets = variation.assetDirection;
  game.generationFingerprint = generationId;
  game.checklist = [
    ...game.checklist,
    "Closest template selected",
    "Agent behavior variation applied",
    "Unique generation fingerprint assigned",
  ];
}

function createFallbackThumbnail(game, generationId) {
  const colors = game.visuals?.colors?.length
    ? game.visuals.colors.slice(0, 3)
    : ["#f03ee8", "#35e8ff", "#101327"];
  const title = String(game.title || "Generated Game")
    .replace(/[<>&'"]/g, "")
    .slice(0, 36);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${colors[0]}"/>
          <stop offset=".52" stop-color="${colors[1] || colors[0]}"/>
          <stop offset="1" stop-color="${colors[2] || "#090b18"}"/>
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" fill="#070914"/>
      <rect x="42" y="42" width="940" height="940" rx="64" fill="url(#bg)" opacity=".9"/>
      <circle cx="${220 + (generationId.charCodeAt(0) % 180)}" cy="350" r="180" fill="#fff" opacity=".16"/>
      <path d="M130 760 L420 310 L610 610 L760 390 L920 760 Z" fill="#080a18" opacity=".72"/>
      <rect x="100" y="790" width="824" height="118" rx="28" fill="#080a18" opacity=".88"/>
      <text x="512" y="860" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="54" font-weight="700">${title}</text>
    </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

async function generateSpecsWithAgent(
  prompt,
  context,
  models = zeroGModels,
  timeoutMs = 10 * 60 * 1000,
) {
  const result = await runBackgroundTask({
    task: "Design complete custom browser game specifications from scratch based on the user prompt. Do NOT use templates. Decide the title, category, mechanic, controls, tuning (parameters object), mood, colors (array of hex colors), assets. Return ONLY a JSON object containing: title, category, mechanic, controls, tuning, mood, colors, assets.",
    input: {
      prompt,
      context: context ?? null
    },
    models,
    timeoutMs,
  });

  const parsed = extractJsonObject(result.content);
  return {
    agent: result,
    specs: parsed || {
      title: "AI Custom Game",
      category: "Arcade",
      mechanic: "Endless scrolling runner with custom obstacles",
      controls: "Tap or Spacebar to jump",
      tuning: { speed: 5, gravity: 15 },
      mood: "retro future cyberpunk",
      colors: ["#ff0055", "#00ffcc", "#110022"],
      assets: "Runner character, moving laser beams, floating gold pixels"
    }
  };
}

export async function generateGameFromPrompt({
  prompt,
  context,
  theme,
  difficulty,
  customization,
  extra,
  includePlan = true,
  includeCode = true,
  includeAssets = true,
  strategy = "hybrid",
  tier,
  requestId: requestIdInput,
}) {
  const requestId =
    requestIdInput ??
    `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const logger = createGenerationLogger(requestId);
  const warnings = [];
  const generationId = nanoid(16);
  let routing = null;
  let selection = null;
  let game = null;
  const isFastRoutingOnly = !includePlan && !includeCode && !includeAssets;
  const routingTimeoutMs = isFastRoutingOnly ? 75_000 : 10 * 60 * 1000;

  logger.log("pipeline.start", {
    tier,
    strategy,
    includePlan,
    includeCode,
    includeAssets,
    isFastRoutingOnly,
    routingTimeoutMs,
    promptLength: prompt?.length ?? 0,
    preferredTemplateId: context?.preferredTemplateId ?? null,
  });

  // The tier OWNS both the model set and the strategy — the client-sent
  // `strategy` is ignored so a free/Tier-1 request can't force a premium
  // pure-agent build. A tier is required: the user picks it in the UI.
  const resolvedTier = normalizeTier(tier);
  if (!resolvedTier) {
    const error = new Error("A tier (1, 2, or 3) is required to generate a game.");
    error.status = 400;
    logger.fail("pipeline.invalid-tier", error);
    throw error;
  }
  const models = getModelsForTier(resolvedTier);
  strategy = getTierStrategy(resolvedTier);
  logger.log("pipeline.tier-resolved", { resolvedTier, strategy, models });

  if (strategy === "pure-agent") {
    try {
      logger.log("pipeline.pure-agent-specs.start", { routingTimeoutMs });
      const design = await generateSpecsWithAgent(prompt, context, models, routingTimeoutMs);
      logger.log("pipeline.pure-agent-specs.done", {
        model: design.agent?.model ?? null,
        title: design.specs?.title ?? null,
      });
      const specs = design.specs;
      
      game = {
        id: Math.random().toString(36).substring(2, 14),
        tier: "prompt-agent",
        title: specs.title || "AI Custom Game",
        templateId: "pure-agent",
        templateName: "Pure AI Agent Game",
        category: specs.category || "Casual",
        createdIn: "15s",
        apiCost: 0.05,
        reliability: "90%",
        customization: {
          prompt,
          theme: specs.mood || "Custom",
          difficulty: difficulty || "normal",
          level: customization || "heavy",
          extra: extra || "none"
        },
        gameplay: {
          mechanic: specs.mechanic || "custom gameplay mechanics",
          controls: specs.controls || "controls",
          tuning: specs.tuning || { speed: 5 },
          states: ["start", "play", "gameover"],
          scoring: "Custom score based on survive duration",
          collision: "Basic rectangle boundary collision"
        },
        visuals: {
          mood: specs.mood || "custom mood",
          colors: specs.colors || ["#ff0055", "#00ffcc"],
          assets: specs.assets || "custom assets",
          externalAssets: false
        },
        build: {
          runtime: "browser",
          renderer: "canvas",
          preview: "playable-canvas",
          targetFps: 60,
          publishReady: true
        },
        publish: {
          ipfsReady: true,
          nftMetadataReady: true,
          marketplaceReady: true
        },
        checklist: [
          "Pure AI Agent specifications generated",
          "Gameplay loops defined by LLM",
          "No template used",
          "Package ready for code generation"
        ]
      };
      
      routing = {
        agent: design.agent,
        selection: {
          templateId: "pure-agent",
          theme: specs.mood || inferThemeFromPrompt(prompt) || null,
          difficulty: difficulty || "normal",
          customization: customization || "heavy",
          extra: extra || "none",
          reason: "Pure Agent design from prompt."
        }
      };
      selection = routing.selection;
    } catch (error) {
      logger.fail("pipeline.pure-agent-specs.failed", error);
      warnings.push(`Pure agent generation failed, falling back to hybrid: ${error.message}`);
      strategy = "hybrid";
    }
  }

  if (strategy !== "pure-agent") {
    let rawVariation = null;
    try {
      logger.log("pipeline.routing.start", { routingTimeoutMs });
      routing = await routeAndVaryWithAgent({
        prompt,
        context,
        generationId,
        models,
        timeoutMs: routingTimeoutMs,
      });
      selection = routing.selection;
      rawVariation = routing.rawVariation;
      logger.log("pipeline.routing.done", {
        templateId: selection?.templateId ?? null,
        model: routing?.agent?.model ?? null,
        reason: selection?.reason ?? null,
      });
    } catch (error) {
      logger.fail("pipeline.routing.failed", error);
      warnings.push(`Background routing fallback: ${error.message}`);
      selection = normalizeSelection(
        {
          templateId: context?.preferredTemplateId,
          theme,
          difficulty,
          customization,
          extra,
        },
        prompt,
      );
    }

    game = createGamePackage({
      templateId: selection.templateId,
      prompt,
      theme: selection.theme,
      difficulty: selection.difficulty,
      customization: selection.customization,
      extra: selection.extra
    });

    const selectedTemplate = templates.find(template => template.id === selection.templateId);
    if (selectedTemplate) {
      const variation = normalizeVariation(rawVariation, {
        prompt,
        template: selectedTemplate,
        generationId
      });
      applyHybridVariation(game, variation, generationId);
      game.generation = {
        variation,
        variationModel: routing?.agent?.model ?? null,
      };
    }
  }

  game.tier = includeCode ? "prompt-agent" : "prompt-template";
  game.generation = {
    ...(game.generation ?? {}),
    mode: "prompt-to-game",
    prompt,
    selection,
    routingModel: routing?.agent?.model ?? null,
    generationId,
    qualityTier: resolvedTier ?? null,
    strategy,
  };

  let plan = null;

  // Pure-agent builds have no template seed, so the coding model works from the
  // raw prompt alone. Give it a structured build plan instead: await the
  // orchestrator BEFORE code generation (sequential on purpose) and inject its
  // output into the coding prompt. Kept tight (800 tokens, 45s, no retries) so
  // a slow orchestrator can't stall the build; on failure we fall back to the
  // raw prompt, exactly like before.
  let pureAgentPlan = null;
  if (strategy === "pure-agent" && includeCode) {
    try {
      pureAgentPlan = await createOrchestrationPlan({
        prompt,
        context: {
          ...(context ?? {}),
          selectedTemplate: selection,
          gamePackage: game
        },
        maxTokens: 800,
        timeoutMs: 45000,
        retries: 0,
        models
      });
      plan = pureAgentPlan;
      game.generation.planModel = pureAgentPlan.model;
    } catch (error) {
      warnings.push(`Orchestrator plan skipped: ${error.message}`);
    }
  }

  const planPromise = includePlan && !pureAgentPlan
    ? createOrchestrationPlan({
        prompt,
        context: {
          ...(context ?? {}),
          selectedTemplate: selection,
          gamePackage: game
        },
        models
      })
    : null;

  // Real in-game sprites: generate the player/environment/objects artwork BEFORE
  // code generation so the code model renders them via KULT_RUNTIME.drawAsset
  // (transparent PNG sprites) instead of drawing shapes. Guarded — if it fails,
  // the game still builds with procedural visuals. Awaited on purpose: the code
  // prompt needs the manifest URLs.
  if (strategy === "pure-agent" && includeCode && includeAssets) {
    try {
      logger.log("pipeline.gameplay-assets.start");
      const gameplayAssets = await generateGameplayAssets(game, { tier: resolvedTier });
      if (gameplayAssets.status === "ready") {
        game.gameplayAssets = gameplayAssets;
        warnings.push(...(gameplayAssets.warnings ?? []));
        logger.log("pipeline.gameplay-assets.done", {
          count: Object.keys(gameplayAssets.manifest).length,
          source: gameplayAssets.source ?? "image",
          model: gameplayAssets.model,
          models: gameplayAssets.models ?? null,
          timings: gameplayAssets.timings ?? null,
          usage: gameplayAssets.usage ?? null,
        });
      } else {
        warnings.push("Gameplay assets unavailable; building with procedural visuals.");
      }
    } catch (error) {
      warnings.push(`Gameplay assets skipped: ${error.message}`);
    }
  }

  let refinement = null;
  let assets = null;
  const codePromise = includeCode
    ? createRefinementBundle({
        gamePackage: game,
        request: prompt,
        refinementLevel: selection.customization,
        strategy,
        plan: pureAgentPlan?.content ?? null,
        tier: resolvedTier,
        models
      })
    : null;
  const coverTitle = (String(game.title || "").replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ") || "GAME").toUpperCase();
  const assetsPromise = includeAssets
    ? generateImageAsset({
        prompt: [
          `${game.title} game cover art`,
          game.gameplay?.mechanic,
          game.visuals?.mood,
          game.generation?.variation?.thumbnailConcept,
          `the bold uppercase title "${coverTitle}" spelled exactly, in a clean large display font across the top like a game cover`,
          `unique generation fingerprint ${generationId}`,
          "polished colorful game cover art, clear gameplay subject, crisp legible lettering, do not reuse a previous composition"
        ].filter(Boolean).join(", "),
        models
      })
    : null;

  const [planResult, codeResult, assetsResult] = await Promise.allSettled([
    planPromise,
    codePromise,
    assetsPromise
  ]);

  logger.log("pipeline.parallel-agents.settled", {
    includePlan,
    includeCode,
    includeAssets,
    plan: planPromise ? planResult.status : "skipped",
    code: codePromise ? codeResult.status : "skipped",
    assets: assetsPromise ? assetsResult.status : "skipped",
    planError: planResult.status === "rejected" ? planResult.reason?.message : null,
    codeError: codeResult.status === "rejected" ? codeResult.reason?.message : null,
    assetsError: assetsResult.status === "rejected" ? assetsResult.reason?.message : null,
  });

  if (includePlan && !pureAgentPlan) {
    if (planResult.status === "fulfilled") {
      plan = planResult.value;
      game.generation.planModel = plan.model;
    } else {
      warnings.push(`Orchestrator skipped: ${planResult.reason.message}`);
    }
  }

  if (includeCode) {
    if (codeResult.status === "fulfilled") {
      refinement = codeResult.value;
      game.refinement = refinement;
      game.generation.codeModel = refinement.model;

      // Playtest (per tier, from .env): run the finished game in a headless
      // browser, have a vision model check the screenshots, and give real
      // problems one fix pass. Never blocks the build if it can't run.
      const playtestConfig = getPlaytestConfig(resolvedTier);
      if (playtestConfig.enabled && refinement.generatedCode) {
        logger.log("pipeline.playtest.start", { model: playtestConfig.model, browser: Boolean(playtestConfig.browserPath) });
        try {
          const { code, ...playtest } = await runPlaytest({ code: refinement.generatedCode, gamePackage: game, config: playtestConfig, models });
          refinement.generatedCode = code;
          game.generation.playtest = playtest;
          logger.log("pipeline.playtest.done", {
            status: playtest.status,
            issues: playtest.issues ?? [],
            fixModel: playtest.fixModel ?? null,
            ms: playtest.ms ?? null
          });
        } catch (error) {
          warnings.push(`Playtest skipped: ${error.message}`);
          logger.log("pipeline.playtest.done", { status: "error", message: error.message });
        }
      }
    } else {
      warnings.push(`Code agent skipped: ${codeResult.reason.message}`);
    }
  }

  if (includeAssets) {
    if (assetsResult.status === "fulfilled") {
      assets = assetsResult.value;
      game.generation.imageModel = assets.model;
      const thumbnail = assets.images?.[0];
      game.thumbnailUrl = thumbnail?.url
        || (thumbnail?.b64_json ? `data:image/png;base64,${thumbnail.b64_json}` : null);
    } else {
      warnings.push(`Image agent skipped: ${assetsResult.reason.message}`);
      game.thumbnailUrl = createFallbackThumbnail(game, generationId);
    }
  }

  if (!game.thumbnailUrl) {
    game.thumbnailUrl = createFallbackThumbnail(game, generationId);
  }

  logger.done({
    gameId: game.id,
    templateId: game.templateId,
    strategy,
    warningCount: warnings.length,
    warnings,
  });

  return {
    game,
    selection,
    plan,
    refinement,
    assets,
    warnings
  };
}
