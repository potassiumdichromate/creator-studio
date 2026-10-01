import { z } from "zod";
import { buildGameCodeZip } from "../services/codeExportService.js";
import {
  deleteGamePackage,
  getGamePackageById,
  listGamePackages,
  saveGamePackage,
  upsertBuildingGamePackage,
  updateGamePackageFields
} from "../services/databaseService.js";
import { createGamePackage } from "../services/gameFactoryService.js";
import { startJob } from "../services/jobService.js";
import { generateGameFromPrompt } from "../services/promptPipelineService.js";
import { createRefinementBundle } from "../services/refinementService.js";
import { generateAndStoreGameThumbnail } from "../services/thumbnailService.js";
import { logActivity } from "../services/activityService.js";
import { putBufferOnZeroG } from "../services/zeroGStorage.js";
import { awardFirstGameBonus, recordCreatorGamePublished } from "../services/pointsService.js";
import { notifyFollowersOfPublish } from "../services/socialService.js";
import { assertGenerationAccess, generationAccessMetadata, fetchGenerationQuotaForAuth } from "../services/generationAccessService.js";
import { consumeGenerationQuota } from "../services/generationQuotaService.js";
import { recordPaymentReceipt, recordGenerationProvenance, recordPublishedSnapshot } from "../services/zeroGProvenanceService.js";
import { logActivityOnChain, ACTIVITY } from "../services/zeroGActivityLog.js";
import { createGenerationLogger } from "../utils/generationLogger.js";
import { computeLayerEnabledFor, getComputeLayerConfig, runComputeBuild } from "../services/computeLayerService.js";
import {
  authIdentityAliases,
  authOwnsIdentity,
  creatorFilterForAuth
} from "../services/identityAliasService.js";

const createSchema = z.object({
  templateId: z.string().min(1),
  prompt: z.string().optional(),
  theme: z.string().optional(),
  difficulty: z.enum(["easy", "normal", "hard", "insane"]).optional(),
  customization: z.enum(["light", "medium", "heavy"]).optional(),
  extra: z.enum(["none", "powerups", "leaderboard", "boss"]).optional(),
  paymentTxHash: z.string().min(1).optional(),
  userId: z.string().optional()
}).strict();

const promptGenerateSchema = z.object({
  prompt: z.string().min(1),
  context: z.record(z.any()).optional(),
  theme: z.string().optional(),
  difficulty: z.enum(["easy", "normal", "hard", "insane"]).optional(),
  customization: z.enum(["light", "medium", "heavy"]).optional(),
  extra: z.enum(["none", "powerups", "leaderboard", "boss"]).optional(),
  includePlan: z.boolean().optional(),
  includeCode: z.boolean().optional(),
  includeAssets: z.boolean().optional(),
  strategy: z.enum(["hybrid", "pure-agent"]).optional(),
  tier: z.coerce.number().int().min(1).max(3),
  paymentMethod: z.enum(["ton", "0g", "stars"]).optional(),
  paymentTxHash: z.string().min(1).optional(),
  starsOrderId: z.string().min(1).optional(),
  userId: z.string().optional()
}).strict();

const refineSchema = z.object({
  gamePackage: z.record(z.any()),
  request: z.string().optional(),
  refinementLevel: z.string().optional()
}).strict();

const exportCodeSchema = z.object({
  gamePackage: z.record(z.any())
}).strict();

// Full builds (code included) go to the compute layer when it is enabled for
// the tier. Returns the same { game, selection, plan, refinement, assets,
// warnings } shape as generateGameFromPrompt, or null to use the legacy
// pipeline (disabled, routing-only request, or failure with fallback on).
async function generateWithComputeLayer({ input, tier, logger }) {
  if (!computeLayerEnabledFor(tier) || input.includeCode === false) return null;
  try {
    logger.log("pipeline.compute-layer.start", { tier });
    const computed = await runComputeBuild({ prompt: input.prompt, tier, refinementLevel: input.customization });
    const game = {
      ...computed.game,
      refinement: computed.refinement,
      generation: {
        ...(computed.game.generation ?? {}),
        computeRunId: computed.runId,
        computeCodeHash: computed.fields["generation.computeCodeHash"],
        qualityTier: tier
      }
    };
    logger.log("pipeline.compute-layer.done", { runId: computed.runId, gameId: game.id });
    return {
      game,
      selection: { templateId: game.templateId, reason: "KULT compute layer" },
      plan: null,
      refinement: computed.refinement,
      assets: null,
      warnings: computed.warnings,
      computeLayer: { runId: computed.runId }
    };
  } catch (error) {
    logger.fail("pipeline.compute-layer.failed", error);
    if (!getComputeLayerConfig().fallback) throw error;
    return null;
  }
}

function titleFromDetailedPrompt(prompt, fallback = "Custom AI Game") {
  return String(prompt || "").match(/^##\s*Title\s*\n\s*\*\*([^*\n]+)\*\*/i)?.[1]?.trim()
    || fallback;
}

// Created games were previously only visible in the browser that generated
// them (localStorage). This lists what the backend actually saved so the
// frontend can show every creation.
export async function listGames(request, response, next) {
  try {
    const limit = Math.min(Number(request.query.limit) || 50, 100);
    const offset = Math.max(Number(request.query.offset) || 0, 0);
    const search = request.query.search || request.query.q;
    const category = request.query.category;
    const creatorId = request.query.creatorId;
    if (creatorId && !authOwnsIdentity(request.auth, creatorId)) {
      response.status(403).json({ error: "You can only list your own draft games" });
      return;
    }
    const ids = request.query.ids
      ? String(request.query.ids).split(",").map((id) => id.trim()).filter(Boolean).slice(0, 100)
      : undefined;
    const games = await listGamePackages({
      limit,
      search,
      category,
      offset,
      creatorId: creatorId ? creatorFilterForAuth(request.auth, creatorId) : undefined,
      ids,
      publishedOnly: !creatorId
    });
    const forReels = String(request.query.forReels ?? "").toLowerCase();
    if (forReels === "1" || forReels === "true") {
      for (let i = games.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [games[i], games[j]] = [games[j], games[i]];
      }
    }
    response.json({ games });
  } catch (error) {
    next(error);
  }
}

export async function listBrowserFeaturedGames(_request, response, next) {
  try {
    const games = await listGamePackages({ limit: 100, publishedOnly: true });
    response.json({
      games: games
        .filter((game) => game.browserFeature?.featured === true)
        .sort((a, b) =>
          (Date.parse(b.browserFeature?.featuredAt ?? "") || 0) -
          (Date.parse(a.browserFeature?.featuredAt ?? "") || 0)
        )
    });
  } catch (error) {
    next(error);
  }
}

export async function checkGenerationAccess(request, response, next) {
  try {
    const creatorId = request.auth?.userId ?? "anonymous";
    const generationAccess = await assertGenerationAccess({
      creatorId,
      creatorAliases: authIdentityAliases(request.auth),
      evmWalletAddress: request.auth?.evmWalletAddress,
      tonWalletAddress: request.auth?.tonWalletAddress,
      paymentTxHash: request.query.paymentTxHash,
      paymentMethod: request.query.paymentMethod,
      tier: request.query.tier,
      auth: request.auth
    });
    response.json({
      ok: true,
      access: generationAccessMetadata(generationAccess)
    });
  } catch (error) {
    next(error);
  }
}

export async function showGenerationQuota(request, response, next) {
  try {
    const creatorId = request.auth?.userId ?? "anonymous";
    const quota = await fetchGenerationQuotaForAuth({
      creatorId,
      creatorAliases: authIdentityAliases(request.auth),
      evmWalletAddress: request.auth?.evmWalletAddress
    });
    response.json({ ok: true, quota });
  } catch (error) {
    next(error);
  }
}

export async function showPublicGame(request, response, next) {
  try {
    const game = await getGamePackageById(request.params.gameId);
    if (!game || game.publish?.published !== true) {
      response.status(404).json({ error: "Published game not found" });
      return;
    }
    response.json({ game });
  } catch (error) {
    next(error);
  }
}

export async function showManagedGame(request, response, next) {
  try {
    const game = await getGamePackageById(request.params.gameId);
    if (!game) {
      response.status(404).json({ error: "Game not found" });
      return;
    }
    if (game.creatorId && !authOwnsIdentity(request.auth, game.creatorId)) {
      response.status(403).json({ error: "Only the creator can access this draft" });
      return;
    }
    response.json({ game });
  } catch (error) {
    next(error);
  }
}

function canPublish(game) {
  if (game?.templateId === "pure-agent") {
    return Boolean(game?.refinement?.generatedCode);
  }
  return Boolean(game?.refinement?.generatedCode || game?.build?.publishReady);
}

export async function publishGame(request, response, next) {
  try {
    const game = await getGamePackageById(request.params.gameId);
    if (!game) {
      response.status(404).json({ error: "Game not found" });
      return;
    }
    if (game.creatorId && !authOwnsIdentity(request.auth, game.creatorId)) {
      response.status(403).json({ error: "Only the creator can publish this game" });
      return;
    }
    if (!canPublish(game)) {
      response.status(409).json({
        error: "This game is still building. Publish it after a playable build is ready."
      });
      return;
    }

    const publishedAt = new Date();
    const publish = {
      ...(game.publish ?? {}),
      published: true,
      status: "published",
      publishedAt,
      playPath: `/play?gameId=${game.id}`
    };
    await updateGamePackageFields(game.id, { publish });
    // 0G: pin an immutable snapshot of the exact build being published.
    recordPublishedSnapshot({ game: { ...game, publish } });
    logActivityOnChain(ACTIVITY.GAME_PUBLISHED, game.id);
    await logActivity({
      userId: request.auth?.userId,
      gameId: game.id,
      gameTitle: game.title,
      activityType: "publish",
      details: `Published game "${game.title}"`
    });
    const canonicalCreatorId = request.auth?.userId ?? game.creatorId;
    const publicationRecord = await recordCreatorGamePublished({
      creatorId: canonicalCreatorId,
      gameId: game.id,
    }).catch((error) => ({ recorded: false, error: error.message }));
    const points = await awardFirstGameBonus({
      creatorId: canonicalCreatorId,
      gameId: game.id,
    }).catch((error) => ({ awarded: false, error: error.message }));
    const notifications = await notifyFollowersOfPublish({ ...game, publish }).catch(() => ({ notified: 0 }));
    response.json({
      ok: true,
      game: { ...game, publish },
      playPath: publish.playPath,
      points,
      publicationRecord,
      notifications
    });
  } catch (error) {
    next(error);
  }
}

export async function unpublishGame(request, response, next) {
  try {
    const game = await getGamePackageById(request.params.gameId);
    if (!game) {
      response.status(404).json({ error: "Game not found" });
      return;
    }
    if (game.creatorId && !authOwnsIdentity(request.auth, game.creatorId)) {
      response.status(403).json({ error: "Only the creator can unpublish this game" });
      return;
    }

    const publish = {
      ...(game.publish ?? {}),
      published: false,
      status: "draft",
      unpublishedAt: new Date()
    };
    await updateGamePackageFields(game.id, { publish });
    await logActivity({
      userId: request.auth?.userId,
      gameId: game.id,
      gameTitle: game.title,
      activityType: "unpublish",
      details: `Unpublished game "${game.title}"`
    });
    response.json({ ok: true, game: { ...game, publish } });
  } catch (error) {
    next(error);
  }
}

const browserFeatureSchema = z.object({
  reason: z.string().max(240).optional(),
}).strict();

export async function featureGameInBrowser(request, response, next) {
  try {
    const game = await getGamePackageById(request.params.gameId);
    if (!game) {
      response.status(404).json({ error: "Game not found" });
      return;
    }
    if (game.creatorId && !authOwnsIdentity(request.auth, game.creatorId)) {
      response.status(403).json({ error: "Only the creator can request browser featuring" });
      return;
    }
    if (game.publish?.published !== true) {
      response.status(409).json({ error: "Only published games can be featured in Browser" });
      return;
    }
    const input = browserFeatureSchema.parse(request.body ?? {});
    const browserFeature = {
      featured: true,
      featuredAt: new Date(),
      requestedBy: request.auth?.userId ?? null,
      reason: input.reason ?? null
    };
    await updateGamePackageFields(game.id, { browserFeature });
    response.json({ ok: true, game: { ...game, browserFeature } });
  } catch (error) {
    next(error);
  }
}

export async function unfeatureGameInBrowser(request, response, next) {
  try {
    const game = await getGamePackageById(request.params.gameId);
    if (!game) {
      response.status(404).json({ error: "Game not found" });
      return;
    }
    if (game.creatorId && !authOwnsIdentity(request.auth, game.creatorId)) {
      response.status(403).json({ error: "Only the creator can remove browser featuring" });
      return;
    }
    const browserFeature = {
      ...(game.browserFeature ?? {}),
      featured: false,
      unfeaturedAt: new Date(),
      requestedBy: request.auth?.userId ?? null
    };
    await updateGamePackageFields(game.id, { browserFeature });
    response.json({ ok: true, game: { ...game, browserFeature } });
  } catch (error) {
    next(error);
  }
}

const saveSchema = z.object({
  gamePackage: z.record(z.any())
}).strict();

// Saves an edited game (title, settings, code) from the post-creation editor.
// Only the creator may modify their game — wallet identity is the user.
export async function saveGame(request, response, next) {
  try {
    const input = saveSchema.parse(request.body);
    const existing = await getGamePackageById(request.params.gameId);
    const requester = request.auth?.userId;
    if (existing?.creatorId && !authOwnsIdentity(request.auth, existing.creatorId)) {
      response.status(403).json({ error: "Only the creator can edit this game" });
      return;
    }
    const gamePackage = {
      ...input.gamePackage,
      id: request.params.gameId,
      // ownership is immutable through this endpoint
      creatorId: existing?.creatorId ?? input.gamePackage.creatorId ?? requester ?? "anonymous",
      // Publication is controlled by the dedicated publish endpoints so a
      // normal save cannot accidentally expose a draft or unpublish a game.
      publish: existing?.publish ?? input.gamePackage.publish ?? {
        published: false,
        status: "draft"
      }
    };
    const persistence = await saveGamePackage(gamePackage);
    await logActivity({
      userId: gamePackage.creatorId,
      gameId: gamePackage.id,
      gameTitle: gamePackage.title,
      activityType: "major_edit",
      details: `Saved changes to "${gamePackage.title || gamePackage.id}"`
    });
    response.json({ ok: true, game: gamePackage, persistence });
  } catch (error) {
    next(error);
  }
}

export async function deleteGame(request, response, next) {
  try {
    const existing = await getGamePackageById(request.params.gameId);
    const requester = request.auth?.userId;
    if (existing?.creatorId && !authOwnsIdentity(request.auth, existing.creatorId)) {
      response.status(403).json({ error: "Only the creator can delete this game" });
      return;
    }
    const { deleted } = await deleteGamePackage(request.params.gameId);
    if (!deleted) {
      response.status(404).json({ error: "Game not found" });
      return;
    }
    response.json({ ok: true, deleted: request.params.gameId });
  } catch (error) {
    next(error);
  }
}

export async function createGame(request, response, next) {
  try {
    const input = createSchema.parse(request.body);
    const creatorId = request.auth?.userId ?? "anonymous";
    const generationAccess = await assertGenerationAccess({
      creatorId,
      creatorAliases: authIdentityAliases(request.auth),
      evmWalletAddress: request.auth?.evmWalletAddress,
      tonWalletAddress: request.auth?.tonWalletAddress,
      paymentTxHash: input.paymentTxHash
    });
    const game = createGamePackage(input);
    game.creatorId = creatorId;
    game.generationAccess = generationAccessMetadata(generationAccess);
    recordPaymentReceipt({ creatorId, gameId: game.id, tier: null, access: generationAccess });
    const persistence = await saveGamePackage(game);
    if (game.creatorId) {
      await logActivity({
        userId: game.creatorId,
        gameId: game.id,
        gameTitle: game.title,
        activityType: "create",
        details: `Created game "${game.title}" from template`
      });
    }
    response.status(201).json({ game, persistence });
  } catch (error) {
    next(error);
  }
}

export async function generateGame(request, response, next) {
  const requestId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const logger = createGenerationLogger(requestId);
  try {
    const input = promptGenerateSchema.parse(request.body);
    const creatorId = request.auth?.userId ?? "anonymous";
    logger.log("request.received", {
      creatorId,
      tier: input.tier,
      strategy: input.strategy ?? null,
      includePlan: input.includePlan ?? true,
      includeCode: input.includeCode ?? true,
      includeAssets: input.includeAssets ?? true,
      promptLength: input.prompt?.length ?? 0,
    });
    // The tier (required — the user picks it in the UI) owns pricing AND the
    // model/strategy set. The same value gates the price and drives generation,
    // so what is charged always matches what is built. Client-sent model/strategy
    // is never trusted.
    const tier = input.tier;
    logger.log("request.generation-access.start");
    const generationAccess = await assertGenerationAccess({
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
    logger.log("request.generation-access.done", {
      free: generationAccess?.free ?? null,
      method: generationAccess?.method ?? null,
    });
    const result = await generateWithComputeLayer({ input, tier, logger })
      ?? await generateGameFromPrompt({ ...input, tier, requestId });
    // Attribute the game to its creator so follows and profile stats are real.
    result.game.creatorId = creatorId;
    result.game.title = titleFromDetailedPrompt(input.prompt, result.game.title);
    result.game.generation = {
      ...(result.game.generation ?? {}),
      prompt: input.prompt
    };
    result.game.generationAccess = generationAccessMetadata(generationAccess);
    if (generationAccess?.quotaCreditKey) {
      await consumeGenerationQuota({
        evmWalletAddress: request.auth?.evmWalletAddress,
        creatorId,
        creditKey: generationAccess.quotaCreditKey
      });
    }
    // 0G provenance: how the game was made + a receipt if it was paid.
    recordGenerationProvenance({ game: result.game });
    recordPaymentReceipt({ creatorId, gameId: result.game.id, tier, access: generationAccess });
    // 0G on-chain activity events.
    logActivityOnChain(ACTIVITY.GAME_GENERATED, result.game.id);
    if (generationAccess && !generationAccess.free) logActivityOnChain(ACTIVITY.PAYMENT, result.game.id);
    result.game.publish = {
      ...(result.game.publish ?? {}),
      published: false,
      status: "draft"
    };
    result.game.buildStatus = result.computeLayer ? "ready" : "building";
    logger.log("request.save.start", { gameId: result.game.id, templateId: result.game.templateId });
    await upsertBuildingGamePackage(result.game);
    const persistence = {
      database: "connected",
      storage: "deferred-to-background-jobs"
    };
    logger.log("request.save.done", {
      gameId: result.game.id,
      persistence: persistence?.storage ?? null,
    });

    // Every generated game (hybrid and pure-agent) gets a real cover image:
    // generated by the image model, downloaded, and stored in the thumbnails
    // collection. Runs in parallel as a background job — the response is not
    // delayed, and the game record is updated when the image lands.
    // A compute-layer build already carries a cover in the game's art style.
    if (!(result.computeLayer && result.game.thumbnailUrl)) {
      const thumbnailJob = startJob("thumbnail-generation", () =>
        generateAndStoreGameThumbnail(result.game)
      );
      result.game.thumbnailJobId = thumbnailJob.id;
    }
    if (result.game.creatorId) {
      await logActivity({
        userId: result.game.creatorId,
        gameId: result.game.id,
        gameTitle: result.game.title,
        activityType: "create",
        details: `Generated game "${result.game.title}" using AI`
      });
    }
    logger.done({
      gameId: result.game.id,
      templateId: result.game.templateId,
      thumbnailJobId: result.game.thumbnailJobId,
    });
    response.status(201).json({ ...result, persistence, requestId });
  } catch (error) {
    logger.fail("request.failed", error);
    next(error);
  }
}

export async function refineGame(request, response, next) {
  try {
    const input = refineSchema.parse(request.body);
    const refinement = await createRefinementBundle(input);
    response.status(202).json({ refinement });
  } catch (error) {
    next(error);
  }
}

export async function exportGameCode(request, response, next) {
  try {
    const input = exportCodeSchema.parse(request.body);
    const { buffer, filename } = await buildGameCodeZip(input.gamePackage);
    const zeroGStorage = await putBufferOnZeroG({
      objectType: "game-export-zip",
      objectId: input.gamePackage.id ?? filename,
      buffer,
      contentType: "application/zip",
      fileName: filename,
      metadata: {
        gameId: input.gamePackage.id ?? null,
        title: input.gamePackage.title ?? null,
        creatorId: input.gamePackage.creatorId ?? null
      }
    });

    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.setHeader("X-0G-Storage-Status", zeroGStorage.status);
    if (zeroGStorage.rootHash) response.setHeader("X-0G-Root-Hash", zeroGStorage.rootHash);
    if (zeroGStorage.txHash) response.setHeader("X-0G-Tx-Hash", zeroGStorage.txHash);
    if (zeroGStorage.uri) response.setHeader("X-0G-URI", zeroGStorage.uri);
    response.send(buffer);
  } catch (error) {
    next(error);
  }
}
