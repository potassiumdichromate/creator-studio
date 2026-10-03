import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.COMPUTE_LAYER_POLL_MS = "10";

const {
  codeHash,
  computeCanEdit,
  embedArt,
  computeLayerEnabledFor,
  runComputeBuild,
  runComputeEdit,
  setComputeLayerStorageForTests
} = await import("../src/services/computeLayerService.js");

const GAME_CODE = "/* KULT_ENGINE_V1 */\nconst g = KULT.game({ title: 'Test' });";

// Minimal stand-in for the compute layer's HTTP API.
function startFakeComputeLayer({ failRun = false } = {}) {
  const calls = [];
  const runs = new Map();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, key: req.headers["x-compute-key"] });
      const json = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
      const nodes = (status) => [{ id: "design", label: "Game Designer", status: "done", models: ["m1"], ms: 5 }, { id: "code", label: "Engineer", status, models: ["coder-x"], ms: 9 }];
      let m;
      if (req.method === "POST" && (req.url === "/v1/runs" || /\/edits$/.test(req.url))) {
        const id = `run_${runs.size + 1}`;
        runs.set(id, { polls: 0, gameId: JSON.parse(body).gameId ?? "gen_game_1" });
        json(202, { id, status: "running", nodes: nodes("running") });
      } else if (req.method === "GET" && (m = req.url.match(/^\/v1\/runs\/(run_\d+)$/))) {
        const run = runs.get(m[1]);
        run.polls += 1;
        if (run.polls < 2) json(200, { id: m[1], status: "running", nodes: nodes("running") });
        else if (failRun) json(200, { id: m[1], status: "failed", error: "qa: broken", nodes: nodes("failed") });
        else json(200, { id: m[1], status: "complete", nodes: nodes("done"), result: { usage: { prompt_tokens: 10, completion_tokens: 20 } } });
      } else if (req.method === "GET" && (m = req.url.match(/^\/v1\/runs\/(run_\d+)\/package$/))) {
        json(200, {
          quality: { codeSource: "engineer", acceptance: { ok: true } },
          game: {
            id: runs.get(m[1]).gameId, title: "Test Game", templateId: "kult-runner",
            style: { palette: { primary: "#ffcc00" } },
            gameplayAssets: { status: "ready", manifest: { player: `${base}/files/player.png`, environment: `${base}/files/env.jpg` }, catalog: [{ name: "player" }] },
            thumbnailUrl: `${base}/files/cover.webp`,
            refinement: { generatedCode: GAME_CODE, source: "engineer", validation: ["Headless acceptance test passed"] },
            generation: { recipe: "runner", design: { title: "Test Game" }, provenance: [{ node: "design", sha256: "abc" }] },
            description: "desc", tags: ["runner"]
          }
        });
      } else if (req.method === "GET" && req.url.startsWith("/files/")) {
        const type = req.url.endsWith(".png") ? "image/png" : req.url.endsWith(".webp") ? "image/webp" : "image/jpeg";
        res.writeHead(200, { "Content-Type": type });
        res.end(Buffer.from(`bytes:${req.url}`));
      } else {
        json(404, { error: "not found" });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

function fakeStorage() {
  const uploads = [];
  return {
    uploads,
    impl: {
      isObjectStorageConfigured: () => true,
      uploadPublicObject: async (key, buffer, contentType) => { uploads.push({ key, contentType, bytes: buffer.length }); return `https://r2.test/${key}`; },
      putBufferOnZeroG: async () => ({ status: "uploaded" })
    }
  };
}

test("compute layer is opt-in per tier", () => {
  delete process.env.COMPUTE_LAYER_URL;
  assert.equal(computeLayerEnabledFor(3), false);
  process.env.COMPUTE_LAYER_URL = "http://compute.test";
  process.env.COMPUTE_LAYER_TIERS = "3";
  assert.equal(computeLayerEnabledFor(3), true);
  assert.equal(computeLayerEnabledFor(1), false);
  delete process.env.COMPUTE_LAYER_TIERS;
});

test("runComputeBuild waits for the run, imports assets, and returns a legacy-shaped refinement", async () => {
  const fake = await startFakeComputeLayer();
  const storage = fakeStorage();
  setComputeLayerStorageForTests(storage.impl);
  process.env.COMPUTE_LAYER_URL = fake.url;
  process.env.COMPUTE_LAYER_KEY = "secret";
  const progress = [];
  try {
    const out = await runComputeBuild({ gameId: "abc123xyz", prompt: "x".repeat(5000), tier: 2, onProgress: (p) => progress.push(p) });

    const create = fake.calls.find((c) => c.method === "POST");
    assert.equal(create.body.gameId, "abc123xyz");
    assert.equal(create.body.tier, 2);
    assert.ok(create.body.prompt.length <= 4000, "prompt is clamped to the compute layer limit");
    assert.equal(create.key, "secret");

    assert.equal(out.runId, "run_1");
    // The code carries its own art so it renders even without the package manifest.
    assert.ok(out.refinement.generatedCode.endsWith(GAME_CODE));
    assert.ok(out.refinement.generatedCode.startsWith("(typeof window"));
    assert.ok(out.refinement.generatedCode.includes('"player":"https://r2.test/sprites/abc123xyz/player.png"'));
    assert.equal(out.refinement.costProfile, "0g-compute-layer");
    assert.equal(out.refinement.model, "coder-x");
    assert.deepEqual(out.refinement.validation, ["Headless acceptance test passed"]);

    // Sprites and cover now live in this backend's storage.
    assert.equal(out.fields.gameplayAssets.manifest.player, "https://r2.test/sprites/abc123xyz/player.png");
    assert.equal(out.fields.gameplayAssets.manifest.environment, "https://r2.test/sprites/abc123xyz/environment.jpg");
    assert.match(out.fields.thumbnailUrl, /^https:\/\/r2\.test\/thumbnails\/abc123xyz\?v=\d+$/);
    assert.equal(storage.uploads.length, 3);

    assert.equal(out.fields["generation.computeRunId"], "run_1");
    assert.equal(out.fields["generation.computeCodeHash"], codeHash(out.refinement.generatedCode));
    assert.equal(out.fields["generation.recipe"], "runner");
    assert.ok(progress.length >= 2 && progress.at(-1).completed === 2, "progress is reported from node states");
  } finally {
    setComputeLayerStorageForTests(null);
    fake.server.close();
    delete process.env.COMPUTE_LAYER_KEY;
  }
});

test("edits go to the parent run only when it built the exact code being edited", async () => {
  const stored = { generation: { computeRunId: "run_9", computeCodeHash: codeHash(GAME_CODE) } };
  assert.equal(computeCanEdit(stored, GAME_CODE), true);
  assert.equal(computeCanEdit(stored, GAME_CODE + "\n// creator tweaked this by hand"), false);
  assert.equal(computeCanEdit({ generation: {} }, GAME_CODE), false);

  const fake = await startFakeComputeLayer();
  setComputeLayerStorageForTests(fakeStorage().impl);
  process.env.COMPUTE_LAYER_URL = fake.url;
  try {
    const out = await runComputeEdit({ parentRunId: "run_9", request: "make it faster", tier: 2 });
    const create = fake.calls.find((c) => c.method === "POST");
    assert.equal(create.url, "/v1/runs/run_9/edits");
    assert.equal(create.body.request, "make it faster");
    assert.ok(out.refinement.generatedCode.endsWith(GAME_CODE));
  } finally {
    setComputeLayerStorageForTests(null);
    fake.server.close();
  }
});

test("embedArt replaces a previous embed instead of stacking", () => {
  const once = embedArt(GAME_CODE, { gameplayAssets: { manifest: { a: "1" } } });
  const twice = embedArt(once, { gameplayAssets: { manifest: { a: "2" } } });
  assert.equal(twice.match(/KULT_EMBEDDED/g).length, 1);
  assert.ok(twice.includes('"a":"2"') && twice.endsWith(GAME_CODE));
});

test("a failed compute run rejects so callers can fall back", async () => {
  const fake = await startFakeComputeLayer({ failRun: true });
  process.env.COMPUTE_LAYER_URL = fake.url;
  try {
    await assert.rejects(runComputeBuild({ prompt: "a game", tier: 1 }), /failed: qa: broken/);
  } finally {
    fake.server.close();
  }
});

test("an unreachable compute layer rejects", async () => {
  process.env.COMPUTE_LAYER_URL = "http://127.0.0.1:9";
  await assert.rejects(runComputeBuild({ prompt: "a game", tier: 1 }));
});
