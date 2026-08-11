// worker.mjs - Grok API 转换层 (Deno Deploy 兼容)
// - OpenAI 兼容端点: /v1/chat/completions, /v1/models, /health
// - 实时探测 Grok 当前可用模型 (缓存 5 分钟)
// - 自动适配模型名 (grok-3 / grok-4 / grok-4-fast / grok-4.5 / grok-4.5-reasoning ...)
//
// 环境变量:
//   GROK_COOKIE  - grok.com 浏览器 Cookie(格式 "sso=ey...; sso-rw=ey...")
//                  留空则使用匿名免登录模式(自动获取匿名身份 cookie)
//   AUTH_USERNAME / AUTH_PASSWORD - 可选 Basic Auth 保护

const GROK_BASE = "https://grok.com";
const CHAT_ENDPOINT = `${GROK_BASE}/rest/app-chat/conversations/new`;

const DEFAULT_HEADERS = {
  "accept": "*/*",
  "accept-language": "en-GB,en;q=0.9",
  "content-type": "application/json",
  "origin": "https://grok.com",
  "priority": "u=1, i",
  "referer": "https://grok.com/",
  "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Brave";v="126"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "sec-gpc": "1",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

// 候选模型清单(动态探测失败时的兜底,会逐步被实际可用模型覆盖)
const CANDIDATE_MODELS = [
  "grok-4.5",
  "grok-4.5-reasoning",
  "grok-4.5-fast",
  "grok-4.5-heavy",
  "grok-4",
  "grok-4-reasoning",
  "grok-4-fast",
  "grok-3",
  "grok-3-reasoning",
  "grok-3-mini",
  "grok-3-fast",
  "grok-code-fast-1",
];

// 模型缓存 (实时探测结果 + 兜底列表)
let MODEL_CACHE = {
  models: null, // string[] of grok.com modelNames
  fetchedAt: 0,
  ttlMs: 5 * 60 * 1000, // 5 分钟
};

// ---------- 工具函数 ----------

function genId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const pick = () => chars[Math.floor(Math.random() * chars.length)];
  return `chatcmpl-${Array.from({ length: 29 }, pick).join("")}`;
}

function cookieHeaderFromObject(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function json(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorJson(status, message) {
  return json(status, { error: { message } });
}

// ---------- 匿名身份获取 ----------

async function fetchAnonymousCookies() {
  const state = { xAnonuserid: null, xChallenge: null, xSignature: null };
  const urls = [
    `${GROK_BASE}/`,
    `${GROK_BASE}/i/flow/login`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": DEFAULT_HEADERS["user-agent"],
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
        redirect: "manual",
      });
      const setCookies = res.headers.getSetCookie?.() ?? [];
      for (const sc of setCookies) {
        const [pair] = sc.split(";");
        const idx = pair.indexOf("=");
        if (idx < 0) continue;
        const key = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (key === "x-anonuserid") state.xAnonuserid = value;
        else if (key === "x-challenge") state.xChallenge = value;
        else if (key === "x-signature") state.xSignature = value;
      }
      if (state.xAnonuserid && state.xChallenge && state.xSignature) break;
    } catch (e) {
      console.error(`[anonymous] ${url} failed: ${e.message}`);
    }
  }
  return cookieHeaderFromObject(state);
}

// ---------- 实时模型探测 ----------

// 尝试多种可能的 grok.com 模型清单端点
async function fetchModelsFromGrok(cookie) {
  const endpoints = [
    `${GROK_BASE}/rest/models`,
    `${GROK_BASE}/api/models`,
    `${GROK_BASE}/rest/app/models`,
    `${GROK_BASE}/i/api/models`,
    `${GROK_BASE}/rest/app-chat/models`,
  ];

  for (const ep of endpoints) {
    try {
      const headers = {
        ...DEFAULT_HEADERS,
        accept: "application/json",
      };
      if (cookie) headers.cookie = cookie;

      const res = await fetch(ep, { method: "GET", headers });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("json")) continue;

      const data = await res.json();
      // 尝试多种可能的模型数组字段
      const list = data?.models ?? data?.data ?? data?.modelNames ?? data?.result?.models;
      if (Array.isArray(list) && list.length > 0) {
        const names = list
          .map((m) => (typeof m === "string" ? m : m?.name ?? m?.id ?? m?.modelName))
          .filter(Boolean);
        if (names.length > 0) {
          console.log(`[models] fetched ${names.length} models from ${ep}`);
          return names;
        }
      }
    } catch (e) {
      console.error(`[models] probe ${ep} failed: ${e.message}`);
    }
  }
  return null;
}

// 获取缓存的模型列表(过期则自动重新探测)
async function getAvailableModels(cookie) {
  const now = Date.now();
  if (MODEL_CACHE.models && (now - MODEL_CACHE.fetchedAt) < MODEL_CACHE.ttlMs) {
    return MODEL_CACHE.models;
  }

  // 先尝试从 grok.com 探测
  let models = null;
  if (cookie) {
    try {
      models = await fetchModelsFromGrok(cookie);
    } catch (e) {
      console.error("[models] live probe failed:", e.message);
    }
  }

  // 探测失败则使用兜底候选 + 缓存兜底(去重)
  if (!models || models.length === 0) {
    const fallback = new Set(CANDIDATE_MODELS);
    if (MODEL_CACHE.models) {
      for (const m of MODEL_CACHE.models) fallback.add(m);
    }
    models = [...fallback];
    console.log(`[models] using fallback: ${models.length} models`);
  }

  MODEL_CACHE = { models, fetchedAt: now, ttlMs: MODEL_CACHE.ttlMs };
  return models;
}

// 对外暴露的 /v1/models 响应数据(OpenAI 兼容格式)
function modelsToOpenAIList(names) {
  return names.map((id) => ({ id, object: "model", created: 0, owned_by: "xAI" }));
}

// ---------- Grok 请求 ----------

// 根据客户端传入的 model 名,智能构造 grok.com payload
// - "grok-4.5-reasoning" → modelName="grok-4.5", isReasoning=true
// - "grok-3" → modelName="grok-3", isReasoning=false
// - "grok-4-fast" → modelName="grok-4-fast" 直接透传
function buildPayload(message, model) {
  // 智能识别 reasoning 后缀
  let modelName = model;
  let isReasoning = false;
  const REASONING_SUFFIXES = ["-reasoning", "-think", "-heavy"];
  for (const suf of REASONING_SUFFIXES) {
    if (model.endsWith(suf)) {
      modelName = model.slice(0, -suf.length);
      isReasoning = true;
      break;
    }
  }

  return {
    temporary: true,
    modelName,
    message,
    fileAttachments: [],
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: true,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: true,
    imageGenerationCount: 2,
    forceConcise: false,
    toolOverrides: {},
    enableSideBySide: true,
    isPreset: false,
    sendFinalMetadata: true,
    customInstructions: "",
    deepsearchPreset: "",
    isReasoning,
  };
}

async function sendToGrok(message, model, cookie) {
  const headers = { ...DEFAULT_HEADERS };
  if (cookie) headers.cookie = cookie;

  const res = await fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(buildPayload(message, model)),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Grok API 错误 ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return res;
}

// ---------- 流式解析: NDJSON -> OpenAI SSE ----------

function ndjsonToSSE(body, { id, created, model, includeUsage = false }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let finalText = null;
  let promptTokens = -1;
  let completionTokens = -1;
  let totalTokens = -1;
  let usageSent = false;

  const writeChunk = (obj) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);

  return new ReadableStream({
    async start(controller) {
        const reader = body.getReader();
        controller.enqueue(
          writeChunk({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          })
        );

        const flush = () => {
          let idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
              const j = JSON.parse(line);
              const resp = j?.result?.response ?? {};
              if (resp?.modelResponse) {
                finalText = resp.modelResponse.message ?? "";
                const delta = finalText.slice(fullText.length);
                if (delta) {
                  fullText = finalText;
                  controller.enqueue(
                    writeChunk({
                      id, object: "chat.completion.chunk", created, model,
                      choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
                    })
                  );
                }
              } else {
                const token = resp?.token ?? "";
                if (token) {
                  fullText += token;
                  controller.enqueue(
                    writeChunk({
                      id, object: "chat.completion.chunk", created, model,
                      choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
                    })
                  );
                }
              }
              const usage = j?.usageMetadata ?? j?.result?.usageMetadata;
              if (usage) {
                promptTokens = usage.promptTokenCount ?? usage.prompt_tokens ?? promptTokens;
                completionTokens = usage.candidatesTokenCount ?? usage.completion_tokens ?? completionTokens;
                totalTokens = usage.totalTokenCount ?? usage.total_tokens ?? totalTokens;
              }
            } catch { /* 忽略非 JSON 行 */ }
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            flush();
          }
          if (buffer.trim()) {
            try {
              const j = JSON.parse(buffer.trim());
              const resp = j?.result?.response ?? {};
              if (resp?.token) {
                fullText += resp.token;
                controller.enqueue(
                  writeChunk({
                    id, object: "chat.completion.chunk", created, model,
                    choices: [{ index: 0, delta: { content: resp.token }, finish_reason: null }],
                  })
                );
              }
            } catch { /* ignore */ }
          }

          if (includeUsage && !usageSent && (promptTokens >= 0 || completionTokens >= 0)) {
            controller.enqueue(
              writeChunk({
                id, object: "chat.completion.chunk", created, model,
                choices: [{ index: 0, delta: {}, finish_reason: null }],
                usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
              })
            );
            usageSent = true;
          }

          controller.enqueue(
            writeChunk({
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              ...(includeUsage && !usageSent
                ? { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } }
                : {}),
            })
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (e) {
          console.error("[stream] error:", e.message);
          controller.enqueue(
            writeChunk({
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { content: `\n[Stream error: ${e.message}]` }, finish_reason: "error" }],
            })
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } finally {
          try { controller.close(); } catch { /* ignore */ }
        }
      },
    });
}

// 聚合 NDJSON 流为完整文本
async function collectText(body) {
  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();
  let buffer = "";
  let fullText = "";
  let finalText = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const resp = j?.result?.response ?? {};
        if (resp?.modelResponse) finalText = resp.modelResponse.message ?? "";
        const token = resp?.token ?? "";
        if (token) fullText += token;
      } catch { /* ignore */ }
    }
  }
  if (buffer.trim()) {
    try {
      const j = JSON.parse(buffer.trim());
      const resp = j?.result?.response ?? {};
      if (resp?.token) fullText += resp.token;
    } catch { /* ignore */ }
  }
  return finalText ?? fullText;
}

// ---------- 请求处理 ----------

function checkAuth(req) {
  const user = Deno.env.get("AUTH_USERNAME");
  const pass = Deno.env.get("AUTH_PASSWORD");
  if (!user || !pass) return true;
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Basic ")) return false;
  try {
    const decoded = atob(auth.slice(6));
    const [u, p] = decoded.split(":");
    return u === user && p === pass;
  } catch {
    return false;
  }
}

async function handleChatCompletions(req) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return errorJson(400, `Invalid JSON: ${e.message}`);
  }

  const messages = body.messages || [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return errorJson(400, "No user message found");
  }
  const content =
    typeof lastUser.content === "string"
      ? lastUser.content
      : lastUser.content?.map((p) => p.text).join("\n") || "";

  const model = body.model || "grok-4.5";
  const stream = !!body.stream;
  const includeUsage = !!body.stream_options?.include_usage;

  // 获取 cookie: 环境变量优先,否则匿名
  let cookie = Deno.env.get("GROK_COOKIE") || Deno.env.get("cookie") || "";
  try {
    if (!cookie) cookie = await fetchAnonymousCookies();
  } catch (e) {
    console.error("[anon] failed:", e.message);
  }

  let grokRes;
  try {
    grokRes = await sendToGrok(content, model, cookie);
  } catch (e) {
    return errorJson(502, e.message);
  }

  const id = genId();
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    const sseStream = ndjsonToSSE(grokRes.body, { id, created, model, includeUsage });
    return new Response(sseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  let text;
  try {
    text = await collectText(grokRes.body);
  } catch (e) {
    return errorJson(502, e.message);
  }
  return json(200, {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 },
  });
}

// ---------- Worker 入口 ----------

export default {
  async fetch(req) {
    // CORS 全开放
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (!checkAuth(req)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Grok Proxy"',
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const url = new URL(req.url);
    let res;

    if (url.pathname === "/v1/models" && req.method === "GET") {
      // 实时探测 grok.com 模型清单(带 cookie 才能探测)
      const cookie = Deno.env.get("GROK_COOKIE") || Deno.env.get("cookie") || "";
      const models = await getAvailableModels(cookie);
      res = json(200, {
        object: "list",
        data: modelsToOpenAIList(models),
        _meta: {
          source: MODEL_CACHE.models === models && MODEL_CACHE.fetchedAt > 0 ? "live+fallback" : "live",
          cache_age_seconds: MODEL_CACHE.fetchedAt ? Math.floor((Date.now() - MODEL_CACHE.fetchedAt) / 1000) : 0,
        },
      });
    } else if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      res = await handleChatCompletions(req);
    } else if (url.pathname === "/health" && req.method === "GET") {
      res = json(200, {
        status: "ok",
        timestamp: new Date().toISOString(),
        model_cache_count: MODEL_CACHE.models?.length ?? 0,
      });
    } else if (url.pathname === "/" && req.method === "GET") {
      res = json(200, {
        name: "Grok Proxy",
        endpoints: ["/v1/models", "/v1/chat/completions", "/health"],
        model: "grok-4.5",
        note: "模型实时探测 / live model discovery",
      });
    } else {
      res = errorJson(404, "Not Found");
    }

    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, headers });
  },
};