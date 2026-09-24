import vm from "node:vm";

// Runtime smoke test for generated games.
//
// findSyntaxError only proves the module PARSES — code like
// `board[row][col] = piece` (where board[row] is undefined) parses fine and
// then throws "Cannot set properties of undefined" the instant it runs, which
// the player sees as "Generated build failed to run…". This executes the module
// in a permissive browser-like sandbox so those top-level (and first-frame)
// runtime crashes are caught before the game is saved as "ready".

const noop = () => {};

// Callable/constructible stub for Web Audio objects used by the smoke test.
function audioStub() {
  return new Proxy(function () {}, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === "then") return undefined;
      if (key === "state") return "running";
      if (key === "sampleRate") return 44100;
      if (key === "currentTime" || key === "value" || key === "length" || key === "duration") return 0;
      return audioStub();
    },
    set() {
      return true;
    },
    apply() {
      return audioStub();
    },
    construct() {
      return audioStub();
    }
  });
}

// Strips the imports/exports the sandbox also strips, so the smoke test runs
// the exact shape the browser executes.
function stripForRun(code) {
  return String(code || "")
    .replace(/^\s*import\s+["'][^"']*["'];?\s*$/gm, "")
    .replace(/^\s*import\s+[^;\n]*from\s+["'][^"']*["'];?\s*$/gm, "")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, "")
    .replace(/^(\s*)export\s+(const|let|var|function|class|async)/gm, "$1$2");
}

// A function that swallows any call/get/new without throwing — used for unknown
// browser globals so a valid game never trips a false "X is not defined".
function makeChainable() {
  const fn = function () {
    return makeChainable();
  };
  return new Proxy(fn, {
    get: (_t, prop) => (prop === Symbol.toPrimitive ? () => 0 : makeChainable()),
    apply: () => makeChainable(),
    construct: () => ({}),
    set: () => true,
  });
}

function makeDom() {
  const styleProxy = new Proxy({}, { get: () => "", set: () => true });
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "measureText") return () => ({ width: 8 });
        if (prop === "getImageData")
          return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
        if (typeof prop === "string" && /^create(Linear|Radial|Conic)Gradient$/.test(prop))
          return () => ({ addColorStop: noop });
        if (prop === "createPattern") return () => ({});
        if (prop === "canvas") return el;
        return noop; // every other ctx method is a no-op
      },
      set: () => true,
    },
  );
  const el = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "getContext") return () => ctx;
        if (prop === "style") return styleProxy;
        if (prop === "classList")
          return { add: noop, remove: noop, toggle: noop, contains: () => false };
        if (prop === "dataset") return {};
        if (prop === "getBoundingClientRect")
          return () => ({ left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540, x: 0, y: 0 });
        if (prop === "querySelector" || prop === "closest") return () => el;
        if (prop === "querySelectorAll") return () => [el];
        if (
          prop === "addEventListener" ||
          prop === "removeEventListener" ||
          prop === "appendChild" ||
          prop === "removeChild" ||
          prop === "setAttribute" ||
          prop === "removeAttribute" ||
          prop === "focus" ||
          prop === "blur" ||
          prop === "play" ||
          prop === "pause" ||
          prop === "load" ||
          prop === "requestPointerLock" ||
          prop === "scrollIntoView"
        )
          return noop;
        if (prop === "children" || prop === "childNodes") return [];
        if (["width", "height", "clientWidth", "clientHeight", "offsetWidth", "offsetHeight"].includes(prop))
          return 960;
        if (prop === "textContent" || prop === "innerHTML" || prop === "value" || prop === "id") return "";
        return undefined;
      },
      set: () => true,
    },
  );
  const documentMock = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "querySelector" || prop === "getElementById" || prop === "createElement")
          return () => el;
        if (
          prop === "querySelectorAll" ||
          prop === "getElementsByClassName" ||
          prop === "getElementsByTagName"
        )
          return () => [el];
        if (prop === "createElementNS") return () => el;
        if (prop === "addEventListener" || prop === "removeEventListener") return noop;
        if (prop === "body" || prop === "documentElement" || prop === "head") return el;
        return undefined;
      },
      set: () => true,
    },
  );
  return { el, ctx, documentMock };
}

/**
 * Executes the generated module and a few animation frames in a mocked browser
 * environment. Returns { ok: true } when it runs without throwing, or
 * { ok: false, error } with the runtime error message when it crashes.
 */
export function runtimeSmokeTest(code, gamePackage) {
  const { el, documentMock } = makeDom();
  let rafQueue = [];
  let timerQueue = [];

  const base = {
    gamePackage: gamePackage ?? {},
    document: documentMock,
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    requestAnimationFrame: (cb) => {
      if (typeof cb === "function") rafQueue.push(cb);
      return rafQueue.length;
    },
    cancelAnimationFrame: noop,
    setTimeout: (cb) => {
      if (typeof cb === "function") timerQueue.push(cb);
      return timerQueue.length;
    },
    clearTimeout: noop,
    setInterval: (cb) => {
      if (typeof cb === "function") timerQueue.push(cb);
      return timerQueue.length;
    },
    clearInterval: noop,
    addEventListener: noop,
    removeEventListener: noop,
    Image: function () {
      return el;
    },
    Audio: function () {
      return el;
    },
    // Web Audio stand-in: any node, param or method call returns another stub,
    // numbers read as 0, so procedural sound code can't crash the smoke test.
    AudioContext: function () {
      return audioStub();
    },
    webkitAudioContext: function () {
      return audioStub();
    },
    devicePixelRatio: 1,
    innerWidth: 960,
    innerHeight: 540,
    performance: { now: () => Date.now() },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    navigator: { userAgent: "node", maxTouchPoints: 0, language: "en" },
    location: { href: "", origin: "", reload: noop, replace: noop },
    alert: noop,
    postMessage: noop,
    parent: { postMessage: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    // Native intrinsics the code legitimately needs to behave normally.
    Math,
    Date,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Symbol,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Float32Array,
    Float64Array,
    Uint8Array,
    Uint8ClampedArray,
    Int8Array,
    Int16Array,
    Int32Array,
    Uint16Array,
    Uint32Array,
    ArrayBuffer,
  };

  // Sandbox global: known keys are the stubs above; any unknown global read
  // returns a harmless chainable so exotic browser APIs never false-positive.
  const sandbox = new Proxy(base, {
    has: () => true, // make every bare identifier resolve on the global (no ReferenceError)
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === Symbol.unscopables) return undefined;
      return makeChainable();
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  base.window = sandbox;
  base.globalThis = sandbox;
  base.self = sandbox;

  const context = vm.createContext(sandbox);
  const source = stripForRun(code);

  // "load" crashes happen as the module first executes — these are real and
  // input-independent (e.g. board[r][c] before board[r] exists). "frame"
  // crashes happen while blindly stepping animation frames with no real input
  // and can be false positives for input-driven games, so callers may treat
  // them as soft.
  try {
    new vm.Script(source, { filename: "generated-game.js" }).runInContext(context, { timeout: 2500 });
  } catch (error) {
    return { ok: false, error: errorMessage(error), line: errorLine(error), phase: "load" };
  }

  // Drive a few frames so crashes inside update/render surface too.
  try {
    for (let round = 0; round < 3; round += 1) {
      const callbacks = rafQueue.concat(timerQueue).slice(0, 40);
      rafQueue = [];
      timerQueue = [];
      for (const cb of callbacks) cb(round * 16);
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error), line: errorLine(error), phase: "frame" };
  }

  return { ok: true, phase: "ok" };
}

function errorMessage(error) {
  if (!error) return "Unknown runtime error";
  return String(error.message || error).slice(0, 300);
}

function errorLine(error) {
  const match = String(error?.stack || "").match(/generated-game\.js:(\d+):\d+/);
  return match ? Number(match[1]) : null;
}
