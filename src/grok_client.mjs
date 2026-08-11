// grok_client.mjs - Grok 网页版 REST API 客户端
// 目标端点: POST https://grok.com/rest/app-chat/conversations/new
// 认证方式:
//   1) GROK_COOKIE 环境变量注入浏览器 Cookie(推荐,稳定)
//   2) 匿名免登录模式(自动获取 x-anonuserid 等匿名身份 Cookie,有限额)

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

const DEFAULT_MODEL = "grok-3";
const SUPPORTED_MODELS = new Set([
  "grok-3",
  "grok-3-reasoning",
  "grok-3-mini",
  "grok-3-mini-reasoning",
  "grok-3-fast",
  "grok-2",
  "grok-2-reasoning",
]);

// 匿名模式下请求需要的 cookie 键(部分缺失时服务端仍可能放行)
const ANON_COOKIE_KEYS = [
  "x-anonuserid",
  "x-challenge",
  "x-signature",
  "x-anon-last-activity",
];

function cookieHeaderFromObject(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export class GrokClient {
  constructor({ cookie, anonymous = true, timeoutMs = 300000 } = {}) {
    this.cookie = cookie;
    this.anonymous = anonymous;
    this.timeoutMs = timeoutMs;
    this.anonState = { // 匿名身份缓存,进程内复用
      xAnonuserid: null,
      xChallenge: null,
      xSignature: null,
      lastActivity: null,
    };
  }

  // 获取匿名身份 cookie
  // 方式: 访问 grok.com 首页 -> 302 -> grok.com/i/flow/login?origin=xxx
  // 在登录页响应中夹带 Set-Cookie: x-anonuserid / x-challenge / x-signature
  async ensureAnonymousCookies() {
    if (this.cookie) return cookieHeaderFromObject(this.cookie);
    if (this.anonState.xAnonuserid) return cookieHeaderFromObject(this.anonState);

    const res = await fetch(`${GROK_BASE}/`, {
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
      if (key === "x-anonuserid") this.anonState.xAnonuserid = value;
      else if (key === "x-challenge") this.anonState.xChallenge = value;
      else if (key === "x-signature") this.anonState.xSignature = value;
    }

    // 若首页未返回,再尝试登录跳转页(i/flow/login)
    if (!this.anonState.xAnonuserid || !this.anonState.xChallenge || !this.anonState.xSignature) {
      const res2 = await fetch(`${GROK_BASE}/i/flow/login`, {
        headers: {
          "user-agent": DEFAULT_HEADERS["user-agent"],
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "manual",
      });
      const setCookies2 = res2.headers.getSetCookie?.() ?? [];
      for (const sc of setCookies2) {
        const [pair] = sc.split(";");
        const idx = pair.indexOf("=");
        if (idx < 0) continue;
        const key = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (key === "x-anonuserid") this.anonState.xAnonuserid = value;
        else if (key === "x-challenge") this.anonState.xChallenge = value;
        else if (key === "x-signature") this.anonState.xSignature = value;
      }
    }

    this.anonState.lastActivity = Date.now();
    return cookieHeaderFromObject(this.anonState);
  }

  // 组装请求头
  async buildHeaders() {
    const cookie = await this.ensureAnonymousCookies();
    const headers = { ...DEFAULT_HEADERS };
    if (cookie) headers.cookie = cookie;
    return headers;
  }

  // 构造对话 payload(参照 mem0ai / RoCry 方案)
  buildPayload(message, { model = DEFAULT_MODEL, isReasoning = false } = {}) {
    let modelName = model;
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

  // 发送消息,返回原始响应体(ReadableStream,NDJSON 流)
  async sendMessage(message, opts = {}) {
    const headers = await this.buildHeaders();
    const payload = this.buildPayload(message, opts);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new Error(`Grok 请求超时(>${this.timeoutMs / 1000}s)`);
      }
      throw err;
    }

    if (!response.ok) {
      clearTimeout(timer);
      const text = await response.text().catch(() => "");
      throw new Error(
        `Grok API 错误 ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`
      );
    }

    return { response, timer };
  }

  // 解析 NDJSON 流,回调 token / 完整消息
  // 返回 { done: Promise } 供调用方等待结束
  parseStream(body, handlers) {
    const { onToken, onFinal, onDone, onError } = handlers;
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    const pump = async (reader) => {
      let fullText = "";
      let finalText = null;
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
              const json = JSON.parse(line);
              const result = json?.result ?? {};
              const resp = result?.response ?? {};

              if (resp?.modelResponse) {
                finalText = resp.modelResponse.message ?? "";
                onFinal?.(finalText, json);
                continue;
              }
              const token = resp?.token ?? "";
              if (token) {
                fullText += token;
                onToken?.(token, fullText, json);
              }
            } catch {
              // 忽略非 JSON 行(心跳等)
            }
          }
        }
        // 末尾残留
        if (buffer.trim()) {
          try {
            const json = JSON.parse(buffer.trim());
            const result = json?.result ?? {};
            const resp = result?.response ?? {};
            if (resp?.token) {
              fullText += resp.token;
              onToken?.(resp.token, fullText, json);
            }
          } catch { /* ignore */ }
        }
        const text = finalText ?? fullText;
        onDone?.(text);
        return text;
      } catch (err) {
        onError?.(err);
        throw err;
      }
    };

    const reader = body.getReader();
    const done = pump(reader);
    return { done };
  }
}
