import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { agentRouter } from "./routes/agentRoutes.js";
import { authRouter } from "./routes/authRoutes.js";
import { dashboardRouter } from "./routes/dashboardRoutes.js";
import { gameRouter } from "./routes/gameRoutes.js";
import { leaderboardRouter } from "./routes/leaderboardRoutes.js";
import { socialRouter } from "./routes/socialRoutes.js";
import { templateRouter } from "./routes/templateRoutes.js";
import { thumbnailRouter } from "./routes/thumbnailRoutes.js";
import { referralAdminRouter, referralRouter } from "./routes/referralRoutes.js";
import { starRouter, telegramRouter } from "./routes/starRoutes.js";
import { creatorSubscriptionRouter } from "./routes/creatorSubscriptionRoutes.js";
import { getDatabaseConfig } from "./services/databaseService.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { getZeroGConfig } from "./services/zeroGService.js";
import { getZeroGStorageConfig } from "./services/zeroGStorage.js";
import { getComputeLayerConfig } from "./services/computeLayerService.js";
import { requestIp, trackReferralClick } from "./services/referralService.js";

dotenv.config();

export const app = express();

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(",").map(origin => origin.trim()) ?? true,
  credentials: true,
  exposedHeaders: ["Content-Disposition"]
}));
app.use(express.json({ limit: "20mb" }));
app.use(morgan("dev"));

app.get("/", (_request, response) => {
  response.json({
    ok: true,
    service: "kult-creator-studio-api",
    message: "Backend is running. Use the /api routes for data.",
    endpoints: {
      health: "/api/health",
      templates: "/api/templates",
      createGame: "/api/games/create",
      generateFromPrompt: "/api/games/generate-from-prompt",
      refineGame: "/api/games/refine",
      exportCode: "/api/games/export-code",
      agents: "/api/agents/stack",
      dashboard: "/api/dashboard",
      leaderboards: "/api/leaderboards/:gameId",
      social: "/api/social"
    },
    database: getDatabaseConfig(),
    agents: getZeroGConfig(),
    storage: getZeroGStorageConfig()
  });
});

app.get("/r/:code", (request, response) => {
  void trackReferralClick({
    code: request.params.code,
    ip: requestIp(request),
    userAgent: request.get("user-agent")
  }).catch(() => {});
  response.cookie("kult_ref", request.params.code, {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production"
  });
  const destination = process.env.PUBLIC_APP_URL
    || process.env.CORS_ORIGIN?.split(",")[0]?.trim()
    || "http://localhost:5173/studio";
  response.redirect(302, destination);
});

const setupRoutes = (prefix) => {
  app.get(`${prefix}/health`, (_request, response) => {
    response.json({
      ok: true,
      service: "kult-creator-studio-api",
      strategy: "template-first-ai-optional",
      database: getDatabaseConfig(),
      agents: getZeroGConfig(),
      computeLayer: getComputeLayerConfig(),
      storage: getZeroGStorageConfig()
    });
  });

  app.use(`${prefix}/auth`, authRouter);
  app.use(`${prefix}/templates`, templateRouter);
  app.use(`${prefix}/games`, gameRouter);
  app.use(`${prefix}/leaderboards`, leaderboardRouter);
  app.use(`${prefix}/agents`, agentRouter);
  app.use(`${prefix}/dashboard`, dashboardRouter);
  app.use(`${prefix}/social`, socialRouter);
  app.use(`${prefix}/stars`, starRouter);
  app.use(`${prefix}/creator-subscription`, creatorSubscriptionRouter);
  app.use(`${prefix}/telegram`, telegramRouter);
  app.use(`${prefix}/thumbnails`, thumbnailRouter);
  app.use(`${prefix}/referral`, referralRouter);
  app.use(`${prefix}/admin/referral`, referralAdminRouter);
};

setupRoutes("/api");
setupRoutes("");
setupRoutes("/studio-backend/api");

app.use(errorHandler);
