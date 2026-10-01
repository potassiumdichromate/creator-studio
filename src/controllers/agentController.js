import { z } from "zod";
import {
  getGamePackageById,
  saveGamePackage,
  upsertBuildingGamePackage,
  updateGamePackageFields
} from "../services/databaseService.js";
import { getJob, serializeJob, startJob } from "../services/jobService.js";
import { generateAndStoreGameThumbnail } from "../services/thumbnailService.js";
import { createRefinementBundle } from "../services/refinementService.js";
import { assertGenerationAccess, assertEditAccess, generationAccessMetadata } from "../services/generationAccessService.js";
import { recordPaymentReceipt, recordGameVersion, recordReferenceInput, recordVoiceInput } from "../services/zeroGProvenanceService.js";
import { logActivityOnChain, ACTIVITY } from "../services/zeroGActivityLog.js";
import { authIdentityAliases, authOwnsIdentity } from "../services/identityAliasService.js";
import {
  computeCanEdit,
  computeLayerEnabledFor,
  getComputeLayerConfig,
  runComputeBuild,
  runComputeEdit
} from "../services/computeLayerService.js";
import {
  analyzeReferenceImage,
  createOrchestrationPlan,
  generateImageAsset,
  getZeroGConfig,
  runBackgroundTask,
  transcribeAudio,
  getModelsForTier,
  getTierStrategy,
  getEditingModelsForTier,
  getEditingStrategy,
  normalizeTier,
  zeroGModels,
  callZeroGChat
} from "../services/zeroGService.js";

const orchestrationSchema = z.object({
  prompt: z.string().min(1),
  context: z.record(z.any()).optional()
}).strict();

const promptEnhancementSchema = z.object({
  prompt: z.string().trim().min(3).max(20000)
}).strict();

const codeSchema = z.object({
  gamePackage: z.record(z.any()),
  request: z.string().optional(),
  refinementLevel: z.string().optional(),
  strategy: z.string().optional(),
  // The quality tier the user picked. Owns the model set + strategy for a fresh
  // build. Optional here because post-creation edits (baseCode) reuse the
  // internal default models instead.
  tier: z.coerce.number().int().min(1).max(3).optional(),
  paymentMethod: z.enum(["ton", "0g", "stars"]).optional(),
  paymentTxHash: z.string().min(1).optional(),
  starsOrderId: z.string().min(1).optional(),
  // Current build source — when present, the agent edits this code instead of
  // generating from a template seed (post-creation "wish" edits).
  baseCode: z.string().optional()
}).strict();

const backgroundSchema = z.object({
  task: z.string().min(1),
  input: z.any().optional()
}).strict();

const assetSchema = z.object({
  prompt: z.string().min(1),
  size: z.string().optional(),
  n: z.number().int().min(1).max(4).optional()
}).strict();

const visionSchema = z.object({
  prompt: z.string().optional(),
  imageUrl: z.string().url().optional(),
  imageBase64: z.string().optional(),
  mimeType: z.string().optional()
}).strict().refine((value) => value.imageUrl || value.imageBase64, {
  message: "imageUrl or imageBase64 is required"
});

const speechSchema = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().optional(),
  language: z.string().optional()
}).strict();

function titleFromDetailedPrompt(prompt, fallback = "Custom AI Game") {
  const markdownTitle = String(prompt || "").match(/^##\s*Title\s*\n\s*\*\*([^*\n]+)\*\*/i)?.[1]?.trim();
  return markdownTitle || fallback;
}

function fallbackGameTitle(prompt) {
  const text = String(prompt || "");
  const existing = text.match(/^##\s*Title\s*\n\s*\*\*([^*\n]+)\*\*/i)?.[1]?.trim();
  if (existing) return existing;
  if (/snowboard|mountain|slope|carv(?:e|ing)/i.test(text)) return "Infinite Alpine Flow";
  if (/football|soccer|world cup/i.test(text)) return "Pocket Football Rush";
  if (/chess|checkmate/i.test(text)) return "Neon Checkmate";
  if (/racing|racer|driv(?:e|ing)|car\b/i.test(text)) return "Velocity Rush";
  const words = text
    .replace(/\b(build|create|make|generate|me|a|an|the|game|please)\b/gi, " ")
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 5);
  return words.length
    ? words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
    : "Custom AI Game";
}

function fallbackEnhancedPrompt(rawPrompt) {
  const withoutExistingTitle = String(rawPrompt)
    .replace(/^##\s*Title\s*\n\s*\*\*[^*\n]+\*\*\s*/i, "")
    .trim();
  const wordCount = withoutExistingTitle.split(/\s+/).filter(Boolean).length;
  const supportingDetail = wordCount < 170
    ? [
        "Make the core interaction immediately understandable and fully playable on desktop and mobile.",
        "Use responsive touch and keyboard controls, clear visual feedback, polished animation, layered sound effects, and lightweight original music.",
        "Build a satisfying gameplay loop with gradual progression, fair challenge, readable objectives, stable performance, and explicit success, failure, restart, and pause states.",
        "Describe a specific environment and scenery that fit the requested genre, including foreground details, layered backgrounds, atmosphere, lighting, weather or ambient motion when appropriate.",
        "Define an original main character, recognizable obstacles, collectibles, enemies, and environmental props with a consistent premium art direction and color palette.",
        "Add satisfying particles, transitions, impact reactions, camera feedback, and readable interface elements without obscuring gameplay.",
        "Explain how the environment changes as difficulty progresses so later stages feel visually and mechanically richer.",
        "Keep every mechanic, environment, character, interface element, and generated asset consistent with the requested genre and theme."
      ].join(" ")
    : "";
  return [
    "## Title",
    `**${fallbackGameTitle(rawPrompt)}**`,
    "",
    withoutExistingTitle,
    supportingDetail
  ].filter(Boolean).join("\n\n");
}

function ensureEnhancementLength(enhancedPrompt) {
  const additions = [
    "Use layered foreground details, animated midground elements, atmospheric background depth, cohesive lighting, and a restrained premium palette so every scene remains readable during fast gameplay.",
    "Vary environmental props, hazards, collectibles, and ambient motion as progression advances while keeping the original character silhouettes and interface visually consistent.",
    "Give every jump, landing, collision, reward, transition, success, and failure an attractive but lightweight visual reaction that performs smoothly on mobile devices."
  ];
  let result = String(enhancedPrompt || "").trim();
  const descriptionWords = () => result
    .replace(/^##\s*Title\s*$/im, "")
    .replace(/^\s*\*\*[^*\n]+\*\*\s*$/m, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;

  for (const addition of additions) {
    if (descriptionWords() >= 280) break;
    result = `${result}\n\n${addition}`;
  }
  return result;
}

// Starts the cover-art job for a game that has neither a cover nor a running
// cover job, and records the job id on the game.
async function startThumbnailIfMissing(gamePackage, storedGame, thumbnailGame) {
  if (gamePackage.thumbnailJobId || storedGame?.thumbnailUrl) return;
  const thumbnailJob = startJob("thumbnail-generation", () =>
    generateAndStoreGameThumbnail(thumbnailGame)
  );
  gamePackage.thumbnailJobId = thumbnailJob.id;
  await updateGamePackageFields(gamePackage.id, { thumbnailJobId: thumbnailJob.id });
}

// { "generation.x": 1, style: {...} } → { generation: { x: 1 }, style: {...} }
// for whole-document saves (targeted updates take the dotted form directly).
function nestDottedFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    const parts = key.split(".");
    let target = out;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = value;
  }
  return out;
}

export function getAgentStack(_request, response) {
  response.json({ ...getZeroGConfig(), computeLayer: getComputeLayerConfig() });
}

export async function orchestrate(request, response, next) {
  try {
    const input = orchestrationSchema.parse(request.body);
    const result = await createOrchestrationPlan(input);
    response.json({ task: "orchestration", result });
  } catch (error) {
    next(error);
  }
}

export async function enhancePrompt(request, response, next) {
  try {
    const { prompt } = promptEnhancementSchema.parse(request.body);
    const model = process.env.PROMPT_ENHANCEMENT || process.env.prompt_enhancement || "MiniMax-M3";
    let result = null;
    try {
      result = await callZeroGChat({
        model,
        temperature: 0.45,
        // Room for the requested ~300-word spec (plus any model preamble). The
        // enhancer model is configurable via PROMPT_ENHANCEMENT (default here).
        maxTokens: 2600,
        timeoutMs: 90000,
        retries: 1,
        messages: [
          {
            role: "system",
            content: [
              "You expand a raw game idea into a build-ready specification.",
              "Read and preserve the complete user prompt even when it is long and already detailed.",
              "The first two lines must use exactly this format:",
              "## Title",
              "**A concise original game title**",
              "After the title, write 280–320 words of detailed game specification, targeting approximately 300 words.",
              "Preserve the user's intended game name, genre, characters, theme, and core mechanic.",
              "Add concrete controls, gameplay loop, scoring, progression, challenge, visual style, sound, responsive mobile layout, and win/lose conditions.",
              "Describe suitable scenery and environment in concrete visual terms: foreground elements, layered background, atmosphere, lighting, environmental motion, obstacles, props, collectibles, character appearance, effects, and a consistent color palette.",
              "When the user references a famous game, preserve the gameplay inspiration but specify original characters, scenery, names, and artwork.",
              "Do not change the requested game into a different genre or reuse an unrelated template.",
              "Apart from the required Title heading, do not add headings, bullet points, commentary, quotation marks, or implementation code.",
              "Return only the enhanced prompt."
            ].join("\n")
          },
          { role: "user", content: prompt }
        ]
      });
    } catch (error) {
      console.warn("Prompt enhancement model failed; preserving the raw prompt", {
        model,
        message: error.message
      });
    }
    const cleanedPrompt = (result?.content ?? "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<think>[\s\S]*$/gi, "")
      .replace(/^\s*(?:\*\*)?enhanced game specification:?(?:\*\*)?\s*/i, "")
      .trim()
      .replace(/^["']|["']$/g, "");
    const description = cleanedPrompt
      .replace(/^##\s*Title\s*$/im, "")
      .replace(/^\s*\*\*[^*\n]+\*\*\s*$/m, "")
      .trim();
    const hasTitle = /^##\s*Title\s*\n\s*\*\*[^*\n]+\*\*/i.test(cleanedPrompt);
    const enhancementCandidate =
      hasTitle && description.length >= 80 && !/<\/?think>/i.test(cleanedPrompt)
        ? cleanedPrompt
        : fallbackEnhancedPrompt(prompt);
    const enhancedPrompt = ensureEnhancementLength(enhancementCandidate);
    response.json({
      rawPrompt: prompt,
      enhancedPrompt,
      model: result?.model ?? "deterministic-fallback"
    });
  } catch (error) {
    next(error);
  }
}

// Code generation runs for minutes — return a jobId immediately and let the
// client poll GET /agents/jobs/:id instead of holding the request open.
export async function generateCode(request, response, next) {
  try {
    const input = codeSchema.parse(request.body);
    const requesterId = request.auth?.userId ?? null;
    const creatorId = requesterId ?? "anonymous";
    const existingGame = input.gamePackage?.id ? await getGamePackageById(input.gamePackage.id) : null;

    // A post-creation EDIT (baseCode present) uses the fully separate EDITING
    // model set + EDITING pricing, keyed by the tier the game was generated at
    // (stored on the package). A fresh BUILD uses the generation TIER{n}_* set +
    // generation pricing, keyed by the tier the user picked.
    const isEdit = Boolean(input.baseCode);
    let models;
    let strategy;
    let generationAccess = null;
    // The compute layer (multi-agent DAG on the KULT Engine) takes the build
    // when enabled for this tier, and an edit when it built the exact code
    // being edited. Otherwise the in-process pipeline runs as before.
    const requestedTier = isEdit
      ? normalizeTier(input.tier ?? input.gamePackage?.generation?.qualityTier) ?? 1
      : normalizeTier(input.tier);
    const useCompute = isEdit
      ? computeLayerEnabledFor(requestedTier) && computeCanEdit(existingGame, input.baseCode)
      : Boolean(requestedTier) && computeLayerEnabledFor(requestedTier);
    if (isEdit) {
      const editTier = normalizeTier(input.tier ?? input.gamePackage?.generation?.qualityTier) ?? 1;
      models = getEditingModelsForTier(editTier);
      strategy = getEditingStrategy(editTier);
      generationAccess = await assertEditAccess({
        creatorId,
        creatorAliases: authIdentityAliases(request.auth),
        evmWalletAddress: request.auth?.evmWalletAddress,
        tonWalletAddress: request.auth?.tonWalletAddress,
        paymentTxHash: input.paymentTxHash,
        paymentMethod: input.paymentMethod,
        starsOrderId: input.starsOrderId,
        auth: request.auth,
        tier: editTier
      });
    } else {
      const tier = normalizeTier(input.tier);
      models = tier ? getModelsForTier(tier) : zeroGModels;
      strategy = tier ? getTierStrategy(tier) : input.strategy;
      // New builds are charged once. If the game already exists (it was priced
      // at the routing step), skip re-charging here.
      if (!existingGame) {
        generationAccess = await assertGenerationAccess({
          creatorId,
          creatorAliases: authIdentityAliases(request.auth),
          evmWalletAddress: request.auth?.evmWalletAddress,
          tonWalletAddress: request.auth?.tonWalletAddress,
          paymentTxHash: input.paymentTxHash,
          paymentMethod: input.paymentMethod,
          starsOrderId: input.starsOrderId,
          auth: request.auth,
          tier
        });
      }
    }
    // 0G receipt for a paid build/edit (whitelisted/free requests record nothing).
    if (generationAccess && !generationAccess.free) {
      recordPaymentReceipt({
        creatorId,
        gameId: input.gamePackage?.id ?? null,
        tier: isEdit ? (normalizeTier(input.tier ?? input.gamePackage?.generation?.qualityTier) ?? 1) : normalizeTier(input.tier),
        access: generationAccess
      });
      logActivityOnChain(ACTIVITY.PAYMENT, input.gamePackage?.id ?? "generation");
    }

    // A tier click starts cover generation immediately, in parallel with code.
    // The editable detailed prompt is the source of truth for both the game
    // title and the cover art direction. Fast Hybrid paths may not have created
    // a DB record yet, so persist a hidden "building" record first.
    if (!isEdit && input.gamePackage?.id) {
      const title = titleFromDetailedPrompt(input.request, input.gamePackage.title);
      const thumbnailGame = {
        ...input.gamePackage,
        title,
        creatorId,
        buildStatus: "building",
        generation: {
          ...(input.gamePackage.generation ?? {}),
          prompt: input.request ?? input.gamePackage.generation?.prompt ?? ""
        },
        publish: {
          ...(input.gamePackage.publish ?? {}),
          published: false,
          status: "draft"
        }
      };
      if (!existingGame) {
        await upsertBuildingGamePackage(thumbnailGame);
      } else {
        await updateGamePackageFields(input.gamePackage.id, {
          title,
          buildStatus: "building",
          "generation.prompt": thumbnailGame.generation.prompt
        });
      }
      input.gamePackage.title = title;
      input.gamePackage.generation = thumbnailGame.generation;
      // Compute-layer builds produce their own cover in the game's art style;
      // the local thumbnail job only runs for legacy builds (or as a fallback).
      if (!useCompute) await startThumbnailIfMissing(input.gamePackage, existingGame, thumbnailGame);
    }
    // 0G on-chain: an edit action (fresh builds are logged as GAME_GENERATED in gameController).
    if (isEdit) logActivityOnChain(ACTIVITY.GAME_EDITED, input.gamePackage?.id ?? "");
    const job = startJob("code-generation", async (updateProgress) => {
      let refinement;
      let computeFields = null;
      try {
        if (useCompute) {
          try {
            const computed = isEdit
              ? await runComputeEdit({
                  parentRunId: existingGame.generation.computeRunId,
                  request: input.request,
                  tier: requestedTier,
                  refinementLevel: input.refinementLevel,
                  onProgress: updateProgress
                })
              : await runComputeBuild({
                  gameId: input.gamePackage?.id,
                  prompt: input.request ?? input.gamePackage?.generation?.prompt ?? input.gamePackage?.customization?.prompt,
                  tier: requestedTier,
                  refinementLevel: input.refinementLevel,
                  onProgress: updateProgress
                });
            refinement = computed.refinement;
            computeFields = computed.fields;
          } catch (computeError) {
            if (!getComputeLayerConfig().fallback) throw computeError;
            console.warn("[compute-layer] falling back to the in-process pipeline", {
              gameId: input.gamePackage?.id ?? null,
              message: computeError.message
            });
            if (!isEdit && input.gamePackage?.id) {
              const latest = await getGamePackageById(input.gamePackage.id).catch(() => null);
              await startThumbnailIfMissing(input.gamePackage, latest, { ...input.gamePackage, creatorId }).catch(() => null);
            }
            refinement = await createRefinementBundle(
              { ...input, strategy, models },
              { onProgress: updateProgress }
            );
          }
        } else {
          refinement = await createRefinementBundle(
            { ...input, strategy, models },
            { onProgress: updateProgress }
          );
        }
      } catch (error) {
        if (input.gamePackage?.id) {
          await updateGamePackageFields(input.gamePackage.id, {
            buildStatus: "failed",
            buildError: error.message
          }).catch(() => null);
        }
        throw error;
      }
      // 0G: record this build/edit as an immutable game version.
      recordGameVersion({ game: input.gamePackage, refinement, kind: isEdit ? "edit" : "build" });
      // Persist the build onto the saved game: without this, the generated
      // code lived only in the requesting browser tab and was lost on reload.
      // Field-targeted update — the thumbnail job may have already written its
      // cover URL onto this game, and a whole-package save would clobber it.
      if (input.gamePackage?.id) {
        try {
          // Only the game's creator may overwrite its stored build.
          const stored = await getGamePackageById(input.gamePackage.id);
          const owned = !stored?.creatorId || authOwnsIdentity(request.auth, stored.creatorId);
          if (owned) {
            if (stored) {
              await updateGamePackageFields(input.gamePackage.id, {
                tier: "ai-refinement",
                refinement,
                buildStatus: refinement?.generatedCode || strategy !== "pure-agent"
                  ? "ready"
                  : "failed",
                ...(computeFields ?? {})
              });
            } else {
              // A confident local template match skips the initial prompt
              // routing request, so this code job may be the first backend
              // contact for the game. Persist it now so it can be published.
              const nested = nestDottedFields(computeFields ?? {});
              await saveGamePackage({
                ...input.gamePackage,
                ...nested,
                generation: { ...(input.gamePackage.generation ?? {}), ...(nested.generation ?? {}) },
                creatorId,
                tier: "ai-refinement",
                refinement,
                buildStatus: refinement?.generatedCode || strategy !== "pure-agent"
                  ? "ready"
                  : "failed",
                generationAccess: generationAccess
                  ? generationAccessMetadata(generationAccess)
                  : input.gamePackage.generationAccess,
                publish: {
                  ...(input.gamePackage.publish ?? {}),
                  published: false,
                  status: "draft"
                }
              });
            }
          }
        } catch (error) {
          console.warn("Could not persist refinement to database", { message: error.message });
        }
      }
      return refinement;
    });
    console.info("[agents/code] job.queued", {
      jobId: job.id,
      gameId: input.gamePackage?.id ?? null,
      tier: isEdit ? (normalizeTier(input.tier ?? input.gamePackage?.generation?.qualityTier) ?? 1) : normalizeTier(input.tier),
      strategy,
      isEdit,
      requestLength: input.request?.length ?? 0,
    });
    response.status(202).json({ task: "code-generation", ...serializeJob(job) });
  } catch (error) {
    next(error);
  }
}

export async function getJobStatus(request, response) {
  const job = await getJob(request.params.jobId);
  if (!job) {
    response.status(404).json({ error: "Job not found or expired" });
    return;
  }
  response.json(serializeJob(job));
}

export async function backgroundTask(request, response, next) {
  try {
    const input = backgroundSchema.parse(request.body);
    // Background model calls can take several minutes. Return immediately and
    // let the client poll the existing jobs endpoint instead of keeping an HTTP
    // request open through browser/proxy timeouts.
    const job = startJob("background", (updateProgress) => {
      updateProgress({ stage: "generating", task: input.task });
      return runBackgroundTask(input);
    });
    response.status(202).json({ task: "background", ...serializeJob(job) });
  } catch (error) {
    next(error);
  }
}

export async function generateAssets(request, response, next) {
  try {
    const input = assetSchema.parse(request.body);
    const result = await generateImageAsset(input);
    response.status(202).json({ task: "image-assets", result });
  } catch (error) {
    next(error);
  }
}

export async function analyzeReference(request, response, next) {
  try {
    const input = visionSchema.parse(request.body);
    const result = await analyzeReferenceImage(input);
    // 0G: record the reference image + its analysis used during creation.
    recordReferenceInput({
      creatorId: request.auth?.userId ?? null,
      prompt: input.prompt,
      imageUrl: input.imageUrl,
      hasImageData: Boolean(input.imageBase64),
      analysis: result?.content ?? null
    });
    response.json({ task: "vision-reference", result });
  } catch (error) {
    next(error);
  }
}

export async function transcribeVoice(request, response, next) {
  try {
    const input = speechSchema.parse(request.body);
    const result = await transcribeAudio(input);
    // 0G: record the voice transcription used during creation.
    recordVoiceInput({ creatorId: request.auth?.userId ?? null, text: result?.text, language: input.language });
    response.json({ task: "speech-to-text", result });
  } catch (error) {
    next(error);
  }
}
