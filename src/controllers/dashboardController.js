import { getGameCollection } from "../services/databaseService.js";
import { authIdentityAliases } from "../services/identityAliasService.js";
import {
  getCommentCountsForGames,
  getEngagementCountsForGames,
  getRecentCommentsPerGame,
} from "../services/socialService.js";
import {
  getCreatorEarningsByGame,
  getCreatorSeries,
  getKultPointsByGame,
  getKultPointsEarned,
} from "../services/pointsService.js";

const VALID_RANGES = new Set(["day", "week", "month", "year"]);

// Loads the authenticated creator's own games (published + finished drafts,
// never templates), projecting only the fields the dashboard needs.
async function loadCreatorGames(aliases, extraFilter = {}) {
  const games = await getGameCollection();
  const rows = await games
    .find(
      {
        ...extraFilter,
        creatorId: { $in: aliases },
        tier: { $ne: "template" },
        $or: [
          { buildStatus: "ready" },
          {
            buildStatus: { $exists: false },
            $or: [
              { "refinement.generatedCode": { $type: "string" } },
              { templateId: { $ne: "pure-agent" } },
            ],
          },
        ],
      },
      {
        projection: {
          _id: 0,
          id: 1,
          title: 1,
          thumbnailUrl: 1,
          views: 1,
          "publish.published": 1,
          createdAt: 1,
        },
      },
    )
    .toArray();
  return rows;
}

function normalizeComment(comment) {
  return {
    id: String(comment._id ?? `${comment.gameId}-${comment.createdAt}`),
    username: comment.username || "Anonymous",
    text: comment.text || "",
    createdAt: comment.createdAt,
  };
}

// Real per-game creator dashboard: Analytics (plays), Activity (likes,
// comments, shares, remixes per game + recent comments) and Earn (Creator
// Score earned per game). Everything is scoped to the authenticated caller's
// own games via their identity aliases.
export async function creatorDashboard(request, response, next) {
  try {
    const aliases = authIdentityAliases(request.auth ?? {});
    response.json(await buildCreatorDashboard(aliases, request.query.range));
  } catch (error) {
    next(error);
  }
}

/**
 * The dashboard payload for a set of creator identities. `gameFilter` narrows
 * the games (Kult Create passes { "studio.agencyId": id } for one studio).
 */
export async function buildCreatorDashboard(aliases, rangeInput, gameFilter = {}) {
  const range = VALID_RANGES.has(String(rangeInput)) ? String(rangeInput) : "week";

  if (aliases.length === 0) {
    return {
      games: [],
      totals: { games: 0, plays: 0, comments: 0, likes: 0, shares: 0, remixes: 0, earned: 0, kultPoints: 0 },
      series: { range, points: [] },
    };
  }

  const rawGames = await loadCreatorGames(aliases, gameFilter);
  const gameIds = rawGames.map((game) => game.id).filter(Boolean);

  const gameCreatedDates = rawGames.map((game) => game.createdAt).filter(Boolean);
  const [commentCounts, engagement, commentPreviews, earnings, kultPoints, kpByGame, series] = await Promise.all([
    getCommentCountsForGames(gameIds),
    getEngagementCountsForGames(gameIds),
    getRecentCommentsPerGame(gameIds, 2),
    getCreatorEarningsByGame(aliases),
    getKultPointsEarned(aliases),
    getKultPointsByGame(aliases),
    getCreatorSeries(aliases, range, gameCreatedDates),
  ]);

  const games = rawGames
    .map((game) => {
      const counts = engagement.byGame[game.id] ?? { likes: 0, shares: 0, remixes: 0 };
      const preview = commentPreviews.byGame[game.id] ?? { items: [], count: 0 };
      return {
        id: game.id,
        title: game.title || "Untitled game",
        thumbnailUrl: game.thumbnailUrl ?? null,
        published: game.publish?.published === true,
        plays: Number(game.views ?? 0),
        comments: commentCounts[game.id] ?? 0,
        likes: counts.likes,
        shares: counts.shares,
        remixes: counts.remixes,
        earned: earnings.byGame[game.id]?.earned ?? 0,
        kpEarned: kpByGame[game.id] ?? 0,
        recentComments: (preview.items ?? []).map(normalizeComment),
      };
    })
    .sort((a, b) => b.plays - a.plays);

  const totals = {
    games: games.length,
    plays: games.reduce((sum, game) => sum + game.plays, 0),
    comments: games.reduce((sum, game) => sum + game.comments, 0),
    likes: engagement.totals.likes,
    shares: engagement.totals.shares,
    remixes: engagement.totals.remixes,
    earned: earnings.total,
    kultPoints,
  };

  return { games, totals, series };
}
