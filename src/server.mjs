// server.mjs - Node.js HTTP 服务,提供 OpenAI 兼容 API
// 端点:
//   POST /v1/chat/completions
//   GET  /v1/models
//   GET  /health
// 环境变量:
//   PORT        监听端口(默认 8000)
//   AUTH_USERNAME / AUTH_PASSWORD  可选 Basic Auth 保护
//   GROK_COOKIE  Grok Cookie 字符串(格式如 "sso=ey...; sso-rw=ey..."),省略则启用匿名模式

import http from "node:http";
import { GrokClient } from "./grok_client.mjs";

const PORT = Number(process.env.PORT || 8000);
const AUTH_USERNAME = process.env.AUTH_USERNAME || "";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const GROK_COOKIE = process.env.GROK_COOKIE || process.env.cookie || "";

const MODELS = [
  { id: "grok-3", object: "model", created: 0, owned_by: "xAI" },
  { id: "grok-3-reasoning", object: "model", created: 0, owned_by: "xAI" },
  { id: "grok-3-mini", object: "model", created: 0, owned_by: "xAI" },
  { id: "grok-3-fast", object: "model", created: 0, owned_by: "xAI" },
];

function checkAuth(req) {
  if (!AUTH_USERNAME || !AUTH_PASSWORD) return true;
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Basic ")) return false;
  const b64 = auth.slice(6);
  try {
    const [u, p] = Buffer.from(b64, "base64").toString("utf8").split(":");
    return u === AUTH_USERNAME && p === AUTH_PASSWORD;
  } catch {
    return false;
  }
}

function unauthorized(res) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Grok Proxy"',
    "Content-Type": "text/plain",
  });
  res.end("Unauthorized");
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj, null, 2));
}

function genId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const pick = () => chars[Math.floor(Math.random() * chars.length)];
  return `chatcmpl-${Array.from({ length: 29 }, pick).join("")}`;
}

function serveModels(res) {
  json(res, 200, { object: "list", data: MODELS });
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    return json(res, 400, { error: { message: `Invalid JSON: ${e.message}` } });
  }

  const messages = body.messages || [];
  const lastUser = messages.filter((m) => m.role === "user").pop();
  if (!lastUser) {
    return json(res, 400, { error: { message: "No user message found" } });
  }
  const content =
    typeof lastUser.content === "string"
      ? lastUser.content
      : lastUser.content?.map((p) => p.text).join("\n") || "";

  const model = body.model || "grok-3";
  const stream = !!body.stream;
  const streamOpt = body.stream_options || {};
  const includeUsage = !!streamOpt.include_usage;

  const client = new GrokClient({
    cookie: GROK_COOKIE,
    anonymous: !GROK_COOKIE,
    timeoutMs: 300000,
  });

  let result;
  try {
    result = await client.sendMessage(content, { model });
  } catch (e) {
    return json(res, 502, { error: { message: e.message } });
  }

  const { response, timer } = result;
  clearTimeout(timer);

  const id = genId();
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    // 非流式:读取整个响应体,聚合 token
    let fullText = "";
    let finalText = null;
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    const reader = response.body.getReader();
    try {
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
            if (resp?.modelResponse) {
              finalText = resp.modelResponse.message ?? "";
            }
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
    } finally {
      reader.releaseLock();
    }
    const text = finalText ?? fullText;
    return json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 },
    });
  }

  // 流式:NDJSON → OpenAI SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const encoder = new TextEncoder();
  const writeChunk = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // 首帧:role
  writeChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let finalText = null;
  let promptTokens = -1;
  let completionTokens = -1;
  let totalTokens = -1;
  let usageReported = false;

  const reader = response.body.getReader();

  const flushBuffer = () => {
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const result = j?.result ?? {};
        const resp = result?.response ?? {};
        if (resp?.modelResponse) {
          finalText = resp.modelResponse.message ?? "";
          const delta = finalText.slice(fullText.length);
          if (delta) {
            fullText = finalText;
            writeChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
          }
        } else {
          const token = resp?.token ?? "";
          if (token) {
            fullText += token;
            writeChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: token }, finish_reason: null }] });
          }
        }
        // 尝试从顶层 usage 提取 token 统计
        const usage = j?.usageMetadata ?? j?.result?.usageMetadata;
        if (usage) {
          promptTokens = usage.promptTokenCount ?? usage.prompt_tokens ?? promptTokens;
          completionTokens = usage.candidatesTokenCount ?? usage.completion_tokens ?? completionTokens;
          totalTokens = usage.totalTokenCount ?? usage.total_tokens ?? totalTokens;
        }
      } catch { /* ignore */ }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      flushBuffer();
    }
    if (buffer.trim()) {
      try {
        const j = JSON.parse(buffer.trim());
        const resp = j?.result?.response ?? {};
        if (resp?.token) {
          fullText += resp.token;
          writeChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: resp.token }, finish_reason: null }] });
        }
        const usage = j?.usageMetadata ?? j?.result?.usageMetadata;
        if (usage) {
          promptTokens = usage.promptTokenCount ?? usage.prompt_tokens ?? promptTokens;
          completionTokens = usage.candidatesTokenCount ?? usage.completion_tokens ?? completionTokens;
          totalTokens = usage.totalTokenCount ?? usage.total_tokens ?? totalTokens;
        }
      } catch { /* ignore */ }
    }

    // usage 报告(若启用)
    if (includeUsage && !usageReported && (promptTokens >= 0 || completionTokens >= 0)) {
      writeChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } });
      usageReported = true;
    }

    // 结束帧
    writeChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(includeUsage && !usageReported ? { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } } : {}) });
    res.write("data: [DONE]\n\n");
  } catch (e) {
    console.error("Stream error:", e);
    writeChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: `\n[Stream error: ${e.message}]` }, finish_reason: "error" }] });
    res.write("data: [DONE]\n\n");
  } finally {
    res.end();
  }
}

async function handleHealth(req, res) {
  json(res, 200, { status: "ok", timestamp: new Date().toISOString() });
}

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req)) return unauthorized(res);
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/v1/models" && req.method === "GET") {
    return serveModels(res);
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, res);
  }
  if (url.pathname === "/health" && req.method === "GET") {
    return handleHealth(req, res);
  }
  if (url.pathname === "/" && req.method === "GET") {
    return handleHealth(req, res);
  }
  json(res, 404, { error: { message: "Not Found" } });
});

server.listen(PORT, () => {
  console.log(`[Grok Proxy] listening on http://0.0.0.0:${PORT}`);
  console.log(`[Config] GROK_COOKIE=${GROK_COOKIE ? "(已设置)" : "(未设置,使用匿名模式)"}`);
  if (AUTH_USERNAME) console.log(`[Config] Basic Auth 已启用`);
});
