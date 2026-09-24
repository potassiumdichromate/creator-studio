const DEFAULT_0G_BASE_URL = "https://router-api.0g.ai/v1";

// Baseline tier for internal paths that carry NO user tier choice: post-creation
// editing, the standalone agent endpoints, and thumbnails (thumbnails use the
// image model, which is the same in every tier). Game GENERATION never uses this
// — there the user must pick a tier by clicking a tier button.
const INTERNAL_TIER = 1;

// Model accessor for those internal paths. There is no "legacy" model set — every
// model comes from a tier (TIER{n}_* in .env).
export const zeroGModels = {
  get general() { return getModelsForTier(INTERNAL_TIER).general; },
  get orchestrator() { return getModelsForTier(INTERNAL_TIER).orchestrator; },
  get coding() { return getModelsForTier(INTERNAL_TIER).coding; },
  get repair() { return getModelsForTier(INTERNAL_TIER).repair; },
  get background() { return getModelsForTier(INTERNAL_TIER).background; },
  get image() { return getModelsForTier(INTERNAL_TIER).image; },
  get vision() { return getModelsForTier(INTERNAL_TIER).vision; },
  get speech() { return getModelsForTier(INTERNAL_TIER).speech; }
};

export function getZeroGConfig() {
  return {
    provider: process.env.LLM_PROVIDER || "0g",
    baseUrl: process.env.ZERO_G_BASE_URL || DEFAULT_0G_BASE_URL,
    hasApiKey: Boolean(process.env.ZERO_G_API_KEY),
    models: zeroGModels
  };
}

// Per-tier model + strategy defaults. Every value can be overridden from .env
// with a TIER{n}_* variable (e.g. TIER3_CODING_MODEL), so the whole tier map is
// controllable without touching code. These defaults are the fallback used when
// a given TIER{n}_* var is not set.
const TIER_DEFAULTS = {
  1: {
    general: "0GM-1.0-35B-A3B",
    orchestrator: "glm-5",
    coding: "gpt-5.6-terra",
    repair: "gpt-5.6-sol",
    background: "deepseek-v4-flash",
    image: "z-image-turbo",
    asset: "z-image-turbo",
    vision: "qwen/qwen3-vl-30b-a3b-instruct",
    speech: "openai/whisper-large-v3",
    strategy: "hybrid"
  },
  2: {
    general: "MiniMax-M3",
    orchestrator: "gpt-5.6-terra",
    coding: "claude-opus-4-8",
    repair: "gpt-5.6-sol",
    background: "deepseek-v4-flash",
    image: "z-image-turbo",
    asset: "z-image-turbo",
    vision: "qwen3.7-plus",
    speech: "openai/whisper-large-v3",
    strategy: "pure-agent"
  },
  3: {
    general: "MiniMax-M3",
    orchestrator: "claude-opus-4-8",
    coding: "claude-opus-5",
    repair: "gpt-5.6-terra",
    background: "deepseek-v4-pro",
    image: "z-image-turbo",
    asset: "z-image-turbo",
    vision: "kimi-k3",
    speech: "openai/whisper-large-v3",
    strategy: "pure-agent"
  }
};

// Accepts 1|2|3, "1"|"2"|"3", or "tier2" etc. Returns 1/2/3 or null when the
// value is absent or invalid (caller then keeps the legacy unprefixed models).
export function normalizeTier(value) {
  if (value === null || value === undefined || value === "") return null;
  const digits = String(value).match(/[123]/);
  const tier = digits ? Number(digits[0]) : NaN;
  return TIER_DEFAULTS[tier] ? tier : null;
}

// Resolves the seven model roles for a tier: env override first
// (TIER{n}_CODING_MODEL, …), then the built-in default above.
export function getModelsForTier(tier) {
  const n = normalizeTier(tier) ?? 2;
  const d = TIER_DEFAULTS[n];
  const env = (suffix) => {
    const value = process.env[`TIER${n}_${suffix}`];
    return value && value.trim() ? value.trim() : null;
  };
  return {
    tier: n,
    general: env("LLM_MODEL") ?? d.general,
    orchestrator: env("ORCHESTRATOR_MODEL") ?? d.orchestrator,
    coding: env("CODING_MODEL") ?? d.coding,
    repair: env("REPAIR_MODEL") ?? d.repair,
    background: env("BACKGROUND_MODEL") ?? d.background,
    image: env("IMAGE_MODEL") ?? d.image,
    asset: env("ASSET_MODEL") ?? d.asset ?? d.image,
    vision: env("VISION_MODEL") ?? d.vision,
    speech: env("SPEECH_MODEL") ?? d.speech
  };
}

// Strategy is fixed per tier by design (Tier 1 = hybrid, Tier 2/3 = pure-agent)
// but still overridable from .env via TIER{n}_STRATEGY.
export function getTierStrategy(tier) {
  const n = normalizeTier(tier) ?? 2;
  const override = process.env[`TIER${n}_STRATEGY`];
  const value = override && override.trim().toLowerCase();
  if (value === "hybrid" || value === "pure-agent") return value;
  return TIER_DEFAULTS[n].strategy;
}

// ---------------------------------------------------------------------------
// EDITING MODELS — a fully separate, independent model set used only for
// post-creation "wish" edits (baseCode present). Controlled from .env with
// EDIT_TIER{n}_* variables, completely independent of the generation TIER{n}_*
// set. Defaults: Tier 1 edits use the Tier 1 models; Tier 2 AND Tier 3 edits
// use the Tier 2 models (edits are seed-edits, so the mid model is enough).
// ---------------------------------------------------------------------------
const EDIT_TIER_DEFAULTS = {
  1: { ...TIER_DEFAULTS[1] },
  2: { ...TIER_DEFAULTS[2] },
  3: { ...TIER_DEFAULTS[2] }
};

// Resolves the seven editing model roles for a tier: EDIT_TIER{n}_* env first,
// then the editing default above.
export function getEditingModelsForTier(tier) {
  const n = normalizeTier(tier) ?? 1;
  const d = EDIT_TIER_DEFAULTS[n];
  const env = (suffix) => {
    const value = process.env[`EDIT_TIER${n}_${suffix}`];
    return value && value.trim() ? value.trim() : null;
  };
  return {
    tier: n,
    general: env("LLM_MODEL") ?? d.general,
    orchestrator: env("ORCHESTRATOR_MODEL") ?? d.orchestrator,
    coding: env("CODING_MODEL") ?? d.coding,
    repair: env("REPAIR_MODEL") ?? d.repair,
    background: env("BACKGROUND_MODEL") ?? d.background,
    image: env("IMAGE_MODEL") ?? d.image,
    asset: env("ASSET_MODEL") ?? d.asset ?? d.image,
    vision: env("VISION_MODEL") ?? d.vision,
    speech: env("SPEECH_MODEL") ?? d.speech
  };
}

export function getEditingStrategy(tier) {
  const n = normalizeTier(tier) ?? 1;
  const override = process.env[`EDIT_TIER${n}_STRATEGY`];
  const value = override && override.trim().toLowerCase();
  if (value === "hybrid" || value === "pure-agent") return value;
  return EDIT_TIER_DEFAULTS[n].strategy;
}

function getClientConfig() {
  const apiKey = process.env.ZERO_G_API_KEY;
  if (!apiKey) {
    const error = new Error("ZERO_G_API_KEY is required for 0G agent calls");
    error.status = 503;
    throw error;
  }

  return {
    apiKey,
    baseUrl: (process.env.ZERO_G_BASE_URL || DEFAULT_0G_BASE_URL).replace(/\/$/, "")
  };
}

async function parseJsonResponse(response) {
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : {};

  if (!response.ok) {
    // Error shape varies: OpenAI-format {error:{message}}, Anthropic-format
    // {error:{message}}, and the 0G router sometimes {error:"<string>"}.
    const message =
      data?.error?.message ||
      (typeof data?.error === "string" ? data.error : null) ||
      `0G API request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = data?.error ?? null;
    throw error;
  }

  return data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetriableError(error) {
  return !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
}

function errorCauseDetails(error) {
  const cause = error?.cause;
  if (!cause) return null;

  return {
    name: cause.name,
    message: cause.message,
    code: cause.code,
    errno: cause.errno,
    syscall: cause.syscall,
    hostname: cause.hostname
  };
}

// Reads an OpenAI-compatible SSE stream and accumulates the assistant message.
// Falls back to parsing a plain (non-streamed) JSON body if the provider
// ignored stream: true.
async function readChatStream(response, onChunk) {
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let content = "";
  let finishReason = null;
  let usage = null;
  let sawSse = false;

  for await (const value of response.body) {
    const text = decoder.decode(value, { stream: true });
    buffer += text;
    raw += text;

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith("data:")) continue;
      sawSse = true;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) content += choice.delta.content;
        if (choice?.message?.content) content += choice.message.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
        onChunk?.(content.length);
      } catch {
        // ignore partial/keepalive lines
      }
    }
  }

  if (!sawSse) {
    const data = raw ? JSON.parse(raw) : {};
    const choice = data?.choices?.[0];
    return {
      content: choice?.message?.content ?? "",
      finishReason: choice?.finish_reason ?? null,
      usage: data.usage ?? null
    };
  }

  return { content, finishReason, usage };
}

// Claude/Anthropic models on the 0G router are NOT served on the OpenAI
// /chat/completions format — they must use the Anthropic Messages endpoint
// (/v1/messages) with its own request/response/stream shape. Everything else
// (GLM, GPT, DeepSeek, Qwen, MiniMax, Kimi…) stays on the OpenAI format.
function isAnthropicModel(model) {
  return /^claude-/i.test(String(model || ""));
}

// Converts the OpenAI-style {messages,temperature,maxTokens} into an Anthropic
// Messages body. The 0G router's Anthropic passthrough rejects a top-level
// `system` field (it 500s), so the system prompt is folded into the first user
// turn instead of sent separately. Text-only messages are flattened to a string;
// a user message that carries OpenAI-style image_url parts is converted to
// Anthropic content blocks so Claude can see the image (used by the code-drawn
// asset review, which shows the model a render of its own SVG).
function toAnthropicPart(part) {
  if (typeof part === "string") return { type: "text", text: part };
  if (part?.type === "image_url") {
    const url = String(part.image_url?.url ?? part.image_url ?? "");
    const match = url.match(/^data:([^;]+);base64,(.+)$/s);
    return match
      ? { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } }
      : { type: "image", source: { type: "url", url } };
  }
  return { type: "text", text: part?.text ?? "" };
}

function toAnthropicBody({ model, messages, maxTokens, thinking }) {
  const systemParts = [];
  const convo = [];
  for (const m of messages) {
    const hasImage = Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url");
    if (hasImage && m.role !== "system") {
      convo.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content.map(toAnthropicPart) });
      continue;
    }
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => (typeof p === "string" ? p : p.text ?? "")).join("\n")
        : String(m.content ?? "");
    if (m.role === "system") systemParts.push(text);
    else convo.push({ role: m.role === "assistant" ? "assistant" : "user", content: text });
  }

  const systemText = systemParts.join("\n\n");
  if (systemText) {
    const firstUser = convo.find((m) => m.role === "user");
    if (!firstUser) convo.unshift({ role: "user", content: systemText });
    else if (Array.isArray(firstUser.content)) firstUser.content.unshift({ type: "text", text: systemText });
    else firstUser.content = `${systemText}\n\n${firstUser.content}`;
  }

  // No `temperature`: Claude thinking models (Fable/Opus on this router) reject
  // it as a deprecated parameter — the model uses its own default.
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    // Claude models on this router think before answering, and that thinking is
    // billed as output and spends the same max_tokens budget — long code runs
    // hit the cap mid-file. Callers can disable it or give it a small budget.
    ...(thinking ? { thinking } : {}),
    messages: convo
  };
}

// Anthropic stop_reason → OpenAI finish_reason, so downstream logic (e.g. the
// "finishReason === 'length' → issue a continuation" path in refinementService)
// keeps working unchanged.
function mapAnthropicStop(reason) {
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return reason ?? null;
}

// Reads an Anthropic Messages SSE stream and accumulates the text. Usage is
// normalized to the OpenAI {prompt_tokens,completion_tokens,total_tokens} shape.
async function readAnthropicStream(response, onChunk) {
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let content = "";
  let finishReason = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let sawSse = false;

  for await (const value of response.body) {
    const text = decoder.decode(value, { stream: true });
    buffer += text;
    raw += text;

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith("data:")) continue;
      sawSse = true;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === "content_block_delta" && evt.delta?.text) {
          content += evt.delta.text;
          onChunk?.(content.length);
        } else if (evt.type === "message_start" && evt.message?.usage) {
          inputTokens = evt.message.usage.input_tokens ?? inputTokens;
        } else if (evt.type === "message_delta") {
          if (evt.delta?.stop_reason) finishReason = mapAnthropicStop(evt.delta.stop_reason);
          if (evt.usage?.output_tokens) outputTokens = evt.usage.output_tokens;
        }
      } catch {
        // ignore partial/keepalive lines
      }
    }
  }

  if (!sawSse) {
    // Provider ignored stream:true — parse the plain Messages JSON body.
    const data = raw ? JSON.parse(raw) : {};
    const textBlocks = Array.isArray(data.content)
      ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("")
      : "";
    return {
      content: textBlocks,
      finishReason: mapAnthropicStop(data.stop_reason),
      usage: data.usage
        ? {
            prompt_tokens: data.usage.input_tokens ?? 0,
            completion_tokens: data.usage.output_tokens ?? 0,
            total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0)
          }
        : null
    };
  }

  return {
    content,
    finishReason,
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  };
}

export async function callZeroGChat({
  model,
  messages,
  temperature = 0.3,
  maxTokens = 2000,
  timeoutMs = 120000,
  retries = 2,
  retryBaseDelayMs = 1000,
  thinking,
  onChunk
}) {
  const { apiKey, baseUrl } = getClientConfig();

  // Optional global override: when ZERO_G_CHAT_TIMEOUT_MS is set (> 0), it wins
  // over every per-call timeoutMs. Lets a long premium run disable step timeouts
  // without touching each call site. Unset → per-call defaults are used as-is.
  const overrideTimeout = Number(process.env.ZERO_G_CHAT_TIMEOUT_MS);
  const effectiveTimeoutMs = Number.isFinite(overrideTimeout) && overrideTimeout > 0
    ? overrideTimeout
    : timeoutMs;

  // Optional global retry floor: when ZERO_G_CHAT_MIN_RETRIES is set, guarantees
  // at least that many retries on top of any per-call value. Transient 502
  // "no message content" empties are retriable, so this keeps a step that runs
  // with retries:0 (specs/routing) from dying on a single hiccup.
  const minRetries = Number(process.env.ZERO_G_CHAT_MIN_RETRIES);
  const effectiveRetries = Number.isFinite(minRetries) && minRetries > retries
    ? minRetries
    : retries;

  for (let attempt = 0; attempt <= effectiveRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    try {
      // Stream the completion: Node's fetch aborts any request whose response
      // headers take more than 5 minutes (undici headersTimeout), and long
      // non-streamed generations exceed that. With streaming, headers arrive
      // immediately and tokens flow as they are produced.
      //
      // Claude models take the Anthropic Messages endpoint/format; everything
      // else takes the OpenAI chat/completions format.
      const anthropic = isAnthropicModel(model);
      const url = anthropic ? `${baseUrl}/messages` : `${baseUrl}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(anthropic ? { "anthropic-version": "2023-06-01" } : {})
        },
        body: JSON.stringify(
          anthropic
            ? toAnthropicBody({ model, messages, maxTokens, thinking })
            : { model, messages, temperature, max_tokens: maxTokens, stream: true }
        )
      });

      if (!response.ok) {
        await parseJsonResponse(response);
      }

      const { content, finishReason, usage } = anthropic
        ? await readAnthropicStream(response, onChunk)
        : await readChatStream(response, onChunk);

      if (!content) {
        const error = new Error("0G API returned no message content");
        error.status = 502;
        throw error;
      }

      return {
        provider: "0g",
        model,
        content,
        finishReason,
        usage
      };
    } catch (originalError) {
      let error = originalError;
      const aborted = error.name === "AbortError" || error.cause?.name === "AbortError";
      if (aborted) {
        error = new Error("0G API request timed out", { cause: originalError });
        error.status = 504;
      } else if (error instanceof SyntaxError) {
        error = new Error("0G API returned an unreadable response", { cause: originalError });
        error.status = 502;
      }

      console.error("0G chat request failed", {
        model,
        attempt: attempt + 1,
        maxAttempts: effectiveRetries + 1,
        status: error.status ?? null,
        message: error.message,
        cause: errorCauseDetails(error)
      });

      if (attempt >= effectiveRetries || !isRetriableError(error)) throw error;
      await sleep(retryBaseDelayMs * (2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function createOrchestrationPlan({ prompt, context, maxTokens = 1800, timeoutMs = 120000, retries = 2, models = zeroGModels }) {
  return callZeroGChat({
    model: models.orchestrator,
    temperature: 0.25,
    maxTokens,
    timeoutMs,
    retries,
    messages: [
      {
        role: "system",
        content: [
          "You are the main orchestrator for a game creation backend.",
          "Turn user intent into a concise build plan.",
          "Route tasks to coding, image, vision, speech, or background agents when useful.",
          "Return practical JSON-like sections: intent, templateFit, steps, agents, risks."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({ prompt, context: context ?? null }, null, 2)
      }
    ]
  });
}

export async function runBackgroundTask({
  task,
  input,
  models = zeroGModels,
  timeoutMs = 10 * 60 * 1000,
  retries = 0
}) {
  return callZeroGChat({
    model: models.background || models.general,
    temperature: 0.2,
    maxTokens: 2000,
    timeoutMs,
    retries,
    messages: [
      {
        role: "system",
        content: [
          "You handle cheap background work for a game creation platform.",
          "Use short, structured output.",
          "Good tasks: metadata, tags, summaries, validation, naming, categorization."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({ task, input }, null, 2)
      }
    ]
  });
}

// Hard ceiling for a single 0G image request. Without this the fetch can hang
// forever on a slow/unresponsive image endpoint, which is what left thumbnail
// jobs stuck in "running" and games without a cover.
const IMAGE_REQUEST_TIMEOUT_MS = Number(process.env.ZERO_G_IMAGE_TIMEOUT_MS) || 90_000;
const IMAGE_MAX_ATTEMPTS = Math.max(1, Number(process.env.ZERO_G_IMAGE_ATTEMPTS) || 3);

export async function generateImageAsset({ prompt, size = "1024x1024", n = 1, models = zeroGModels }) {
  const { apiKey, baseUrl } = getClientConfig();

  let lastError;
  for (let attempt = 1; attempt <= IMAGE_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: models.image, prompt, size, n }),
        signal: controller.signal
      });
      const data = await parseJsonResponse(response);
      const images = data.data ?? [];
      if (images.length === 0) throw new Error("Image agent returned no image");
      return { provider: "0g", model: models.image, images, usage: data.usage ?? null };
    } catch (error) {
      lastError = error.name === "AbortError"
        ? new Error(`0G image request timed out after ${IMAGE_REQUEST_TIMEOUT_MS}ms`)
        : error;
      if (attempt < IMAGE_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("0G image request failed");
}

export async function analyzeReferenceImage({ prompt, imageUrl, imageBase64, mimeType = "image/png" }) {
  const imagePayload = imageUrl || `data:${mimeType};base64,${imageBase64}`;

  return callZeroGChat({
    model: zeroGModels.vision,
    temperature: 0.2,
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content: [
          "You analyze visual references for a game creation platform.",
          "Extract art direction, UI style, color palette, asset ideas, and implementation notes."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt || "Analyze this reference for a game build." },
          { type: "image_url", image_url: { url: imagePayload } }
        ]
      }
    ]
  });
}

function base64ToBlob(base64, mimeType) {
  const buffer = Buffer.from(base64, "base64");
  return new Blob([buffer], { type: mimeType });
}

export async function transcribeAudio({ audioBase64, mimeType = "audio/webm", language }) {
  const { apiKey, baseUrl } = getClientConfig();
  const formData = new FormData();
  formData.set("model", zeroGModels.speech);
  formData.set("file", base64ToBlob(audioBase64, mimeType), "voice-input.webm");
  if (language) formData.set("language", language);

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`
    },
    body: formData
  });

  const data = await parseJsonResponse(response);
  return {
    provider: "0g",
    model: zeroGModels.speech,
    text: data.text ?? "",
    raw: data
  };
}
