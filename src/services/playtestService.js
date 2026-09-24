import { existsSync } from "node:fs";
import sharp from "sharp";
import { callZeroGChat, normalizeTier } from "./zeroGService.js";
import { repairFromPlaytest } from "./refinementService.js";

// Playtest: run the finished game in a headless browser on a phone-sized
// screen, take screenshots at load, after tapping start and after a few seconds
// of play, and have a vision model check what a player would actually see.
// Real problems get one fix pass; the fix is kept only if the game still loads
// cleanly afterwards. Controlled per tier from .env (TIER{n}_PLAYTEST*); skipped
// when no Chrome/Chromium is available.

const VIEWPORT = { width: 390, height: 844 };

const BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
];

export function getPlaytestConfig(tier) {
  const n = normalizeTier(tier);
  const raw = (suffix) => {
    const value = n ? process.env[`TIER${n}_PLAYTEST${suffix}`] : undefined;
    return value && value.trim() ? value.trim() : null;
  };
  const on = (value, fallback) => (value === null ? fallback : /^(1|true|yes|on)$/i.test(value));
  return {
    enabled: Boolean(n) && on(raw(""), false),
    model: raw("_MODEL") ?? "claude-sonnet-5",
    fix: on(raw("_FIX"), true),
    fixModel: raw("_FIX_MODEL"),
    browserPath: [process.env.PLAYTEST_BROWSER_PATH?.trim(), ...BROWSER_CANDIDATES].find((p) => p && existsSync(p)) ?? null
  };
}

// Same page shape the frontend builds: the package as a const, then the module
// with its local imports/exports stripped.
function prepareModule(code) {
  const unresolvable = (specifier) => !/^(?:https?:)?\/\//.test(specifier);
  return String(code || "")
    .replace(/^[ \t]*import\s*(?:[\w$*,{}\s]*?\bfrom\s*)?["']([^"']+)["'][ \t]*;?/gm, (match, spec) => (unresolvable(spec) ? "" : match))
    .replace(/^[ \t]*export\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[\w$,\s]*\})\s*from\s*["']([^"']+)["'][ \t]*;?/gm, (match, spec) => (unresolvable(spec) ? "" : match))
    .replace(/^[ \t]*export\s+default\s+/gm, "")
    .replace(/^[ \t]*export\s*\{[^}]*\}[ \t]*;?[ \t]*$/gm, "")
    .replace(/^([ \t]*)export\s+(const|let|var|function|class|async)/gm, "$1$2");
}

// The frontend runs games in a sandboxed iframe where real localStorage throws,
// so its harness shadows both storages with an in-memory Storage. The playtest
// page must do the same, or games that save a best score look broken here but
// run fine for players. Kept in sync with GeneratedGameFrame's storage shim.
const STORAGE_SHIM = `(function () {
  function memoryStorage() {
    const data = new Map();
    const api = {
      getItem: function (k) { return data.has(String(k)) ? data.get(String(k)) : null; },
      setItem: function (k, v) { data.set(String(k), String(v)); },
      removeItem: function (k) { data.delete(String(k)); },
      clear: function () { data.clear(); },
      key: function (i) { const keys = Array.from(data.keys()); return i in keys ? keys[i] : null; },
      get length() { return data.size; }
    };
    return new Proxy(api, {
      get: function (t, p) { if (p in t) return t[p]; return typeof p === "string" && data.has(p) ? data.get(p) : undefined; },
      set: function (t, p, v) { data.set(String(p), String(v)); return true; },
      deleteProperty: function (t, p) { data.delete(String(p)); return true; },
      has: function (t, p) { return p in t || data.has(String(p)); }
    });
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try { window[name].getItem("__kult_probe__"); return; } catch (e) {}
    try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (e) {}
  });
})();`;

function buildPage(code, gamePackage) {
  const { refinement, ...safe } = gamePackage;
  void refinement;
  // An embedded data-URI cover can be megabytes and isn't needed to play.
  if (typeof safe.thumbnailUrl === "string" && safe.thumbnailUrl.startsWith("data:")) safe.thumbnailUrl = null;
  const json = JSON.stringify(safe).replace(/</g, "\\u003c");
  const moduleBody = `const gamePackage = ${json};\n${prepareModule(code)}`.replace(/<\/script>/gi, "<\\/script>");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#070a12;overflow:hidden}#game{display:block;touch-action:none}</style>
</head><body><canvas id="game"></canvas>
<script>${STORAGE_SHIM}\nwindow.reportScore=function(){};</script>
<script type="module">${moduleBody}</script>
</body></html>`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A near-uniform screenshot means nothing was drawn.
async function isBlank(png) {
  const { channels } = await sharp(png).greyscale().stats();
  return (channels[0]?.stdev ?? 0) < 3;
}

export async function capturePlaytest({ code, gamePackage, browserPath }) {
  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio", "--autoplay-policy=no-user-gesture-required"]
  });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page.on("pageerror", (error) => errors.push(`Uncaught error: ${String(error?.message ?? error).slice(0, 300)}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`Console error: ${message.text().slice(0, 300)}`);
    });
    page.on("requestfailed", (request) => errors.push(`Failed to load ${request.url().slice(0, 160)}`));
    await page.setContent(buildPage(code, gamePackage), { waitUntil: "load", timeout: 30000 });

    const shots = [];
    const shoot = async (label) => shots.push({ label, png: Buffer.from(await page.screenshot({ type: "png" })) });

    await wait(1500);
    await shoot("1.5 s after loading (start screen)");
    await page.touchscreen.tap(VIEWPORT.width / 2, VIEWPORT.height * 0.62);
    await page.keyboard.press("Enter");
    await wait(1800);
    await shoot("1.8 s after tapping to start");
    for (const [x, y] of [[100, 620], [290, 620], [195, 700], [110, 620], [280, 620]]) {
      await page.touchscreen.tap(x, y);
      await wait(250);
    }
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowLeft", "ArrowRight"]) {
      await page.keyboard.press(key);
      await wait(200);
    }
    await wait(800);
    await shoot("after about 4 s of play with taps and arrow keys");
    return { shots, errors: [...new Set(errors)].slice(0, 12), blank: await isBlank(shots.at(-1).png) };
  } finally {
    await browser.close();
  }
}

function parseVerdict(text) {
  const source = String(text || "").replace(/```(?:json)?/gi, "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Playtest reviewer returned no JSON");
  const parsed = JSON.parse(source.slice(start, end + 1));
  const issues = Array.isArray(parsed.issues) ? parsed.issues.map((i) => String(i).slice(0, 300)).filter(Boolean).slice(0, 8) : [];
  return { pass: parsed.pass === true && issues.length === 0, issues };
}

export async function judgePlaytest({ shots, errors, blank, gamePackage, model }) {
  const response = await callZeroGChat({
    model,
    maxTokens: 1200,
    retries: 2,
    timeoutMs: 180000,
    messages: [
      {
        role: "system",
        content: [
          "You are the QA lead of a mobile web game studio. You see screenshots of a game running on a 390x844 phone screen, in time order.",
          "Report only REAL problems a player would clearly notice:",
          "- a blank, black or frozen screen, or nothing changes after tapping to start;",
          "- sprites missing, drawn as boxes or placeholders, far too small to read, stretched, or facing the wrong way;",
          "- HUD or menu text cut off, overlapping, off-screen or too small to read;",
          "- important elements off-screen, hidden behind the HUD, or obvious rendering glitches;",
          "- the runtime errors listed, if they break something.",
          "Do not report taste, balance, difficulty, or anything you cannot see.",
          'Reply ONLY with JSON: {"pass": true|false, "issues": ["short, specific, fixable description", ...]}. Use pass true with an empty issues list when nothing is really wrong.'
        ].join("\n")
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `Game: ${gamePackage.title || "Game"} — ${gamePackage.gameplay?.mechanic || ""}`,
              `Controls: ${gamePackage.gameplay?.controls || ""}`,
              `Screenshots: ${shots.map((s, i) => `${i + 1}) ${s.label}`).join("; ")}.`,
              blank ? "Automatic check: the last screenshot is almost uniform (possibly blank)." : null,
              errors.length ? `Runtime errors:\n${errors.join("\n")}` : "Runtime errors: none."
            ].filter(Boolean).join("\n")
          },
          ...shots.map((shot) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${shot.png.toString("base64")}` } }))
        ]
      }
    ]
  });
  return { ...parseVerdict(response.content), usage: response.usage ?? null, model: response.model };
}

// Runs the whole playtest and returns { status, pass, issues, errors, fixed, code, ... }.
// `code` is the module to keep: the fixed one only if the fix loaded cleanly.
export async function runPlaytest({ code, gamePackage, config, models }) {
  const started = Date.now();
  if (!config.browserPath) return { status: "skipped", reason: "no Chrome/Chromium found (set PLAYTEST_BROWSER_PATH)", code };

  const first = await capturePlaytest({ code, gamePackage, browserPath: config.browserPath });
  const verdict = await judgePlaytest({ ...first, gamePackage, model: config.model });
  const uncaught = first.errors.filter((e) => e.startsWith("Uncaught"));
  const issues = [...verdict.issues, ...uncaught];
  const base = {
    reviewModel: verdict.model,
    reviewUsage: verdict.usage,
    errors: first.errors,
    blank: first.blank,
    issues
  };
  if (verdict.pass && !uncaught.length && !first.blank) {
    return { ...base, status: "passed", pass: true, fixed: false, ms: Date.now() - started, code };
  }
  if (!config.fix || !issues.length) {
    return { ...base, status: "failed", pass: false, fixed: false, ms: Date.now() - started, code };
  }

  const fixModel = config.fixModel || models?.repair || models?.coding;
  const repair = await repairFromPlaytest({ code, issues, gamePackage, model: fixModel });
  if (!repair.ok) {
    return { ...base, status: "fix-rejected", pass: false, fixed: false, fixModel, fixUsage: repair.usage, fixProblem: repair.problem, ms: Date.now() - started, code };
  }
  // Keep the fix only if it still loads without new uncaught errors, draws
  // something, AND looks better to the same reviewer (passes, or fewer
  // problems) — a fix that runs but renders worse must not replace the original.
  const after = await capturePlaytest({ code: repair.code, gamePackage, browserPath: config.browserPath });
  const newUncaught = after.errors.filter((e) => e.startsWith("Uncaught") && !uncaught.includes(e));
  const afterVerdict = after.blank || newUncaught.length
    ? null
    : await judgePlaytest({ ...after, gamePackage, model: config.model });
  const keep = Boolean(afterVerdict) && (afterVerdict.pass || afterVerdict.issues.length < issues.length);
  return {
    ...base,
    status: keep ? "fixed" : "fix-reverted",
    pass: Boolean(afterVerdict?.pass),
    fixed: keep,
    fixModel,
    fixUsage: repair.usage,
    afterErrors: after.errors,
    afterIssues: afterVerdict?.issues ?? null,
    afterReviewUsage: afterVerdict?.usage ?? null,
    ms: Date.now() - started,
    code: keep ? repair.code : code
  };
}
