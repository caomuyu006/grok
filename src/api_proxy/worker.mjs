// worker.mjs - Grok API 转换层 (Deno Deploy 兼容)
// 将 OpenAI 兼容请求 (/v1/chat/completions, /v1/models) 转换为
// grok.com 内部 REST API 调用,并将 NDJSON 流转换为 OpenAI SSE 格式
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

const MODELS = [
  { id: "grok-3", object: "model", created: 0, owned_by: "xAI" },
  { id: "grok-3-reasoning", object: "model", created: 0, owned_by: "xAI" },
  { id: "grok-3-mini", object: "model", created: 0, owned_by: "xAI" },
  { id: "grok-3-fast", object: "model", created: 0, owned_by: "xAI" },
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

// 访问 grok.com 首页/登录页,从 302 响应 Set-Cookie 中提取匿名身份 cookie
async function fetchAnonymousCookies() {
  const state = { xAnonuserid: null, xChallenge: null, xSignature: null };

  const urls = [
    { url: `${GROK_BASE}/`, label: "home" },
    { url: `${GROK_BASE}/i/flow/login`, label: "login" },
  ];

  for (const { url } of urls) {
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

// ---------- Grok 请求 ----------

function buildPayload(message, model) {
  let modelName = model;
  let isReasoning = false;
  if (model.endsWith("-reasoning")) {
    modelName = model.replace("-reasoning", "");
    isReasoning = true;
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

// 发送消息到 grok.com,返回 Response
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

// 将 grok 的 NDJSON 流转换为 OpenAI 兼容 SSE 流
// 返回新的 ReadableStream
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

  const model = body.model || "grok-3";
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

  // 非流式: 聚合后返回完整 JSON
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
    // CORS 全开放(所有 OPTIONS 预检直接放行)
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
      res = json(200, { object: "list", data: MODELS });
    } else if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      res = await handleChatCompletions(req);
    } else if (url.pathname === "/health" && req.method === "GET") {
      res = json(200, { status: "ok", timestamp: new Date().toISOString() });
    } else if (url.pathname === "/" && req.method === "GET") {
      res = json(200, {
        name: "Grok Proxy",
        endpoints: ["/v1/models", "/v1/chat/completions", "/health"],
        model: "grok-3",
      });
    } else {
      res = errorJson(404, "Not Found");
    }

    // 附加 CORS 头
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, headers });
  },
};
