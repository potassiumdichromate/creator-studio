import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getGameCollection, getGamePackageById, saveGamePackage } from "../services/databaseService.js";
import { importComputeRun } from "../services/computeLayerService.js";
import { logActivity } from "../services/activityService.js";
import { recordGenerationProvenance, recordPublishedSnapshot } from "../services/zeroGProvenanceService.js";
import { logActivityOnChain, ACTIVITY } from "../services/zeroGActivityLog.js";
import { awardFirstGameBonus, recordCreatorGamePublished } from "../services/pointsService.js";
import { getCommentCountsForGames, getEngagementCountsForGames, notifyFollowersOfPublish } from "../services/socialService.js";
import { buildCreatorDashboard } from "./dashboardController.js";

// Internal API for Kult Create (the game-studio building in Kult World).
// Kult Create runs the build on the compute layer itself and bills its own
// studio credits; this endpoint only imports the finished run as a creator
// studio game owned by the studio's wallet and, optionally, publishes it with
// the same steps as publishGame. Authenticated by KULT_CREATE_SERVICE_KEY.

const importSchema = z.object({
  runId: z.string().min(4).max(80),
  creatorWallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  studio: z.object({
    agencyId: z.string().max(60),
    name: z.string().max(60),
    okxAgentId: z.string().max(40).optional().default(""), // studios may skip OKX.ai
    ceoTokenId: z.string().max(40).optional(),
    ceoName: z.string().max(80).optional()
  }),
  publish: z.boolean().default(true),
  gameId: z.string().max(60).optional()
});

export function requireKultCreateKey(request, response, next) {
  const key = process.env.KULT_CREATE_SERVICE_KEY;
  const given = String(request.get("x-kult-create-key") || "");
  if (!key) { response.status(503).json({ error: "Kult Create is not enabled on this server (KULT_CREATE_SERVICE_KEY)" }); return; }
  const ok = given.length === key.length && timingSafeEqual(Buffer.from(given), Buffer.from(key));
  if (!ok) { response.status(401).json({ error: "Invalid x-kult-create-key" }); return; }
  next();
}

export async function importKultCreateGame(request, response, next) {
  try {
    const input = importSchema.parse(request.body);
    const creatorId = input.creatorWallet.toLowerCase();
    const computed = await importComputeRun(input.runId);
    const gameId = computed.game.id;
    const existing = await getGamePackageById(gameId);
    if (existing?.creatorId && existing.creatorId.toLowerCase() !== creatorId) {
      response.status(409).json({ error: "This game already belongs to another creator" });
      return;
    }
    const now = new Date();
    const publish = input.publish
      ? { ...(existing?.publish ?? {}), published: true, status: "published", publishedAt: existing?.publish?.publishedAt ?? now, updatedAt: now, playPath: `/play?gameId=${gameId}` }
      : existing?.publish ?? { published: false, status: "draft" };
    const game = {
      ...computed.game,
      id: gameId,
      creatorId,
      refinement: computed.refinement,
      studio: { ...input.studio, source: "kult-create" },
      generation: {
        ...(computed.game.generation ?? {}),
        computeRunId: computed.runId,
        computeCodeHash: computed.fields["generation.computeCodeHash"],
        origin: "kult-create"
      },
      publish
    };
    await saveGamePackage(game);
    if (!existing) recordGenerationProvenance({ game });
    await logActivity({
      userId: creatorId, gameId, gameTitle: game.title, activityType: input.publish ? "publish" : "create",
      details: `${input.publish ? "Published" : "Saved"} "${game.title}" from the ${input.studio.name} studio (Kult Create)`
    }).catch(() => {});

    let extras = {};
    if (input.publish) {
      recordPublishedSnapshot({ game });
      logActivityOnChain(ACTIVITY.GAME_PUBLISHED, gameId);
      if (!existing?.publish?.published) {
        const [publicationRecord, points, notifications] = await Promise.all([
          recordCreatorGamePublished({ creatorId, gameId }).catch((error) => ({ recorded: false, error: error.message })),
          awardFirstGameBonus({ creatorId, gameId }).catch((error) => ({ awarded: false, error: error.message })),
          notifyFollowersOfPublish(game).catch(() => ({ notified: 0 }))
        ]);
        extras = { publicationRecord, points, notifications };
      }
    }
    console.info("[kult-create] game imported", { gameId, runId: computed.runId, studio: input.studio.name, published: input.publish, warnings: computed.warnings.length });
    response.status(existing ? 200 : 201).json({
      ok: true, gameId, title: game.title, status: publish.status, playPath: publish.playPath ?? null,
      playUrl: publish.playPath && process.env.CREATOR_STUDIO_PUBLIC_URL ? `${process.env.CREATOR_STUDIO_PUBLIC_URL.replace(/\/$/, "")}${publish.playPath}` : publish.playPath ?? null,
      thumbnailUrl: game.thumbnailUrl ?? null, warnings: computed.warnings, ...extras
    });
  } catch (error) {
    next(error);
  }
}

const dashboardSchema = z.object({
  agencyId: z.string().min(4).max(60),
  wallets: z.string().transform((s) => s.split(",").map((w) => w.trim().toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w))).pipe(z.array(z.string()).min(1).max(10)),
  range: z.enum(["day", "week", "month", "year"]).default("week")
});

// The CEO dashboard's engagement numbers: the same payload as the creator
// dashboard, limited to the games one Kult Create studio published.
export async function kultCreateDashboard(request, response, next) {
  try {
    const { agencyId, wallets, range } = dashboardSchema.parse(request.query);
    response.json(await buildCreatorDashboard(wallets, range, { "studio.agencyId": agencyId }));
  } catch (error) {
    next(error);
  }
}

// The most-played published games made in Kult Create, across every studio,
// for the "Top games" board inside the Kult Create office.
export async function kultCreateTopGames(request, response, next) {
  try {
    const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 50);
    const games = await getGameCollection();
    const rows = await games
      .find(
        { "studio.source": "kult-create", "publish.published": true },
        { projection: { _id: 0, id: 1, title: 1, thumbnailUrl: 1, views: 1, studio: 1, "generation.computeRunId": 1, "publish.publishedAt": 1, "publish.playPath": 1 } }
      )
      .sort({ views: -1, "publish.publishedAt": -1 })
      .limit(limit)
      .toArray();
    const ids = rows.map((g) => g.id);
    const [engagement, comments] = await Promise.all([getEngagementCountsForGames(ids), getCommentCountsForGames(ids)]);
    const base = process.env.CREATOR_STUDIO_PUBLIC_URL?.replace(/\/$/, "") || null;
    response.json({
      games: rows.map((g) => {
        const e = engagement.byGame[g.id] ?? { likes: 0, shares: 0, remixes: 0 };
        return {
          id: g.id,
          title: g.title || "Untitled game",
          thumbnailUrl: g.thumbnailUrl ?? null,
          plays: Number(g.views ?? 0),
          likes: e.likes, shares: e.shares, remixes: e.remixes,
          comments: comments[g.id] ?? 0,
          studio: { agencyId: g.studio?.agencyId ?? null, name: g.studio?.name ?? null, ceoName: g.studio?.ceoName ?? null },
          computeRunId: g.generation?.computeRunId ?? null,
          playUrl: base && g.publish?.playPath ? `${base}${g.publish.playPath}` : null,
          publishedAt: g.publish?.publishedAt ?? null
        };
      })
    });
  } catch (error) {
    next(error);
  }
}
