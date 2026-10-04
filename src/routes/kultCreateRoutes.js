import { Router } from "express";
import { importKultCreateGame, kultCreateDashboard, kultCreateTopGames, requireKultCreateKey } from "../controllers/kultCreateController.js";

// Service-to-service routes for Kult Create (see kultCreateController.js).
export const kultCreateRouter = Router();

kultCreateRouter.post("/games", requireKultCreateKey, importKultCreateGame);
kultCreateRouter.get("/dashboard", requireKultCreateKey, kultCreateDashboard);
kultCreateRouter.get("/top-games", requireKultCreateKey, kultCreateTopGames);
