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

// ---------- 实时模型清单 (参照 gemini-main 直接转发 Grok 官方响应) ----------

// Grok.com 唯一面向用户的模型清单端点: POST https://grok.com/rest/models
// 响应结构: { models: [{ modelId, name, modelMode, tags, ... }], defaultFreeModel, defaultProModel, ... }
// tag 含 "SKIP_LIST_MODES" 表示该模型仅供内部使用, 不向用户公开
const GROK_MODELS_ENDPOINT = `${GROK_BASE}/rest/models`;

// 实时从 Grok 官方拉取当前可用模型 (无缓存, 每次 /v1/models 请求都会刷新)
// 失败则返回 CANDIDATE_MODELS 兑底列表
async function fetchLiveModels(cookie) {
  if (!cookie) {
    console.log("[models] no cookie, using fallback list");
    return [...CANDIDATE_MODELS];
  }

  try {
    const res = await fetch(GROK_MODELS_ENDPOINT, {
      method: "POST",
      headers: {
        ...DEFAULT_HEADERS,
        accept: "application/json",
        cookie,
      },
      body: JSON.stringify({}), // 空 body 也能返回完整列表
    });

    if (!res.ok) {
      console.error(`[models] grok.com ${res.status}`);
      return [...CANDIDATE_MODELS];
    }

    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];

    // 仅保留面向用户的模型: 过滤掉带 SKIP_LIST_MODES tag 的内部模型
    const visible = models
      .filter((m) => m && m.modelId && !(m.tags || []).includes("SKIP_LIST_MODES"))
      .map((m) => m.modelId);

    // 动态加入默认订阅模型 (Pro/Heavy), 普通用户也能看到 (调用才报错)
    const defaults = [data.defaultFreeModel, data.defaultProModel, data.defaultAnonModel, data.defaultHeavyModel]
      .filter(Boolean)
      .filter((id, idx, arr) => arr.indexOf(id) === idx);

    const allIds = Array.from(new Set([...visible, ...defaults, ...CANDIDATE_MODELS]));
    console.log(`[models] live: ${visible.length} visible, ${defaults.length} defaults, ${allIds.length} total`);
    return allIds;
  } catch (e) {
    console.error(`[models] live fetch failed: ${e.message}`);
    return [...CANDIDATE_MODELS];
  }
}

// 对外暴露的 /v1/models 响应数据 (OpenAI 兼容格式)
// 实时从 grok.com 拉取, 失败返回兑底 (与 gemini-main 行为一致)
async function handleModelsList() {
  const cookie = Deno.env.get("GROK_COOKIE") || Deno.env.get("cookie") || "";
  const names = await fetchLiveModels(cookie);
  return json(200, {
    object: "list",
    data: names.map((id) => ({ id, object: "model", created: 0, owned_by: "xAI" })),
  });
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
      // 实时从 grok.com 拉取模型清单 (参照 gemini-main)
      res = await handleModelsList();
    } else if (url.pathname === "/debug/probe-models" && req.method === "GET") {
      // 一次性探测所有可能的模型清单端点(开发用)
      const cookie = Deno.env.get("GROK_COOKIE") || Deno.env.get("cookie") || "";
      const probes = [
        // GET 探测
        { ep: "https://grok.com/v1/models", method: "GET" },
        { ep: "https://grok.com/v1beta/models", method: "GET" },
        { ep: "https://grok.com/api/v1/models", method: "GET" },
        { ep: "https://grok.com/rest/v1/models", method: "GET" },
        { ep: "https://grok.com/rest/app/models", method: "GET" },
        { ep: "https://grok.com/rest/app-chat/models", method: "GET" },
        { ep: "https://grok.com/rest/models/list", method: "GET" },
        { ep: "https://grok.com/rest/app-chat/models/list", method: "GET" },
        { ep: "https://grok.com/rest/conversations/models", method: "GET" },
        // /rest/models 已知存在, 但 501 = 仅允许 POST
        { ep: "https://grok.com/rest/models", method: "POST", body: {} },
        { ep: "https://grok.com/rest/models", method: "POST", body: { type: "all" } },
        { ep: "https://grok.com/rest/models", method: "POST", body: { includeDeprecated: true } },
      ];
      const results = [];
      for (const { ep, method, body } of probes) {
        try {
          const opts = {
            method,
            headers: {
              "user-agent": DEFAULT_HEADERS["user-agent"],
              "accept": "application/json, text/plain, */*",
              "accept-language": "en-GB,en;q=0.9",
              ...(cookie && { cookie }),
            },
            redirect: "manual",
          };
          if (body) {
            opts.headers["content-type"] = "application/json";
            opts.body = JSON.stringify(body);
          }
          const r = await fetch(ep, opts);
          const ct = r.headers.get("content-type") || "";
          const text = await r.text();
          results.push({
            endpoint: ep,
            method,
            status: r.status,
            contentType: ct.split(";")[0],
            preview: text.replace(/\n/g, " "),
          });
        } catch (e) {
          results.push({ endpoint: ep, method, error: e.message });
        }
      }
      res = json(200, { probe_results: results, has_cookie: !!cookie });
    } else if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      res = await handleChatCompletions(req);
    } else if (url.pathname === "/debug/inspect-headers" && req.method === "GET") {
      // 采集浏览器对话时的完整请求 (匿名访问 grok.com 首页, 收集响应头/cookie)
      const collect = async (url, method = "GET", extraHeaders = {}) => {
        const r = await fetch(url, {
          method,
          headers: {
            "user-agent": DEFAULT_HEADERS["user-agent"],
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.9",
            "accept-encoding": "gzip, deflate, br",
            ...extraHeaders,
          },
          redirect: "follow",
        });
        const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
        return {
          status: r.status,
          url: r.url,
          requestHeadersSent: { user_agent: DEFAULT_HEADERS["user-agent"], ...extraHeaders },
          responseHeaders: Object.fromEntries(r.headers.entries()),
          setCookieNames: setCookies.map(sc => sc.split("=")[0]),
          contentLength: (await r.clone().text()).length,
        };
      };
      const probes = [
        { name: "grok.com homepage", url: "https://grok.com/" },
        { name: "grok.com rest/app-chat/conversations/new (GET, 验证存在)", url: "https://grok.com/rest/app-chat/conversations/new" },
        { name: "grok.com rest/app-chat/conversations/new (POST, 匿名)", url: "https://grok.com/rest/app-chat/conversations/new", method: "POST", body: { temporary: true, modelName: "grok-3", message: "hi" } },
      ];
      const results = [];
      for (const p of probes) {
        try {
          const opts = { method: p.method };
          if (p.body) {
            opts.headers = { "content-type": "application/json" };
            opts.body = JSON.stringify(p.body);
          }
          const r = await fetch(p.url, {
            ...opts,
            headers: { ...DEFAULT_HEADERS, ...(opts.headers || {}) },
            redirect: "manual",
          });
          const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
          results.push({
            name: p.name,
            status: r.status,
            responseHeaders: Object.fromEntries(r.headers.entries()),
            setCookies,
            bodyPreview: (await r.text()).slice(0, 400),
          });
        } catch (e) {
          results.push({ name: p.name, error: e.message });
        }
      }
      res = json(200, { results });
    } else if (url.pathname === "/debug/test-chat" && req.method === "GET") {
      // 手动测试一次对话请求, 返回详细诊断信息 (仅诊断用)
      const cookie = Deno.env.get("GROK_COOKIE") || Deno.env.get("cookie") || "";
      const reqBody = {
        temporary: true,
        modelName: "grok-3",
        message: "hi",
        fileAttachments: [],
        imageAttachments: [],
        disableSearch: false,
        enableImageGeneration: false,
        returnImageBytes: false,
        returnRawGrokInXaiRequest: false,
        enableImageStreaming: false,
        imageGenerationCount: 0,
        forceConcise: false,
        toolOverrides: {},
        enableSideBySide: true,
        isPreset: false,
        sendFinalMetadata: true,
        customInstructions: "",
        deepsearchPreset: "",
        isReasoning: false,
      };
      const headers = { ...DEFAULT_HEADERS };
      if (cookie) headers.cookie = cookie;
      let debugRes = { ok: false };
      try {
        const r = await fetch(CHAT_ENDPOINT, {
          method: "POST",
          headers,
          body: JSON.stringify(reqBody),
        });
        const t = await r.text();
        debugRes = {
          ok: r.ok,
          status: r.status,
          statusText: r.statusText,
          responseHeaders: Object.fromEntries(r.headers.entries()),
          body: t.slice(0, 1500),
          sentHeaders: { ...headers, cookie: cookie ? "[REDACTED " + cookie.length + " chars]" : "" },
          sentBodySize: JSON.stringify(reqBody).length,
          cookieLength: cookie.length,
        };
      } catch (e) {
        debugRes = { error: e.message };
      }
      res = json(200, debugRes);
    } else if (url.pathname === "/health" && req.method === "GET") {
      res = json(200, {
        status: "ok",
        timestamp: new Date().toISOString(),
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