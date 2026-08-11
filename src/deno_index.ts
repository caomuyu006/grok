// deno_index.ts - Grok 代理 Deno 入口
// 提供两种模式:
//   1. WebSocket 代理: 将客户端 WebSocket 直连 grok.com(旧版兼容)
//   2. OpenAI 兼容 API: /v1/chat/completions, /v1/models, /health (新版,参照 gemini-main)
// 
// Deno 本地运行: deno run --allow-net --allow-env src/deno_index.ts
// Deno Deploy:  直接部署此文件或 deno.json 指定 start

// ---------- WebSocket 代理(旧版兼容) ----------
async function handleWebSocket(req: Request): Promise<Response> {
  const { socket: clientWs, response } = Deno.upgradeWebSocket(req);

  const url = new URL(req.url);
  const targetUrl = `wss://grok.com${url.pathname}${url.search}`;

  console.log("[WS] Target URL:", targetUrl);

  const pendingMessages: string[] = [];
  const targetWs = new WebSocket(targetUrl);

  targetWs.onopen = () => {
    console.log("[WS] Connected to grok");
    pendingMessages.forEach((msg) => targetWs.send(msg));
    pendingMessages.length = 0;
  };

  clientWs.onmessage = (event) => {
    console.log("[WS] Client message received");
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(event.data);
    } else {
      pendingMessages.push(event.data);
    }
  };

  targetWs.onmessage = (event) => {
    console.log("[WS] Grok message received");
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(event.data);
    }
  };

  clientWs.onclose = (event) => {
    console.log("[WS] Client connection closed");
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1000, event.reason);
    }
  };

  targetWs.onclose = (event) => {
    console.log("[WS] Connection closed");
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(event.code, event.reason);
    }
  };

  targetWs.onerror = (error) => {
    console.error("[WS] WebSocket error:", error);
  };

  return response;
}

// ---------- API 代理(新版,参照 gemini-main) ----------
async function handleAPIRequest(req: Request): Promise<Response> {
  try {
    const worker = await import("./api_proxy/worker.mjs");
    return await worker.default.fetch(req);
  } catch (error) {
    console.error("[API] Worker error:", error);
    return new Response(JSON.stringify({ error: { message: error.message } }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ---------- 主 handler ----------
async function handler(req: Request): Promise<Response> {
  // WebSocket 升级
  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }
  // HTTP 请求走 API 代理
  return handleAPIRequest(req);
}

// ---------- 启动服务 ----------
const port = Number(Deno.env.get("PORT") || 8000);
console.log(`[Grok Proxy] Deno server starting on http://0.0.0.0:${port}`);

// Deno.serve 兼容 Deno 2.x / Deno Deploy
// deno run --allow-net --allow-env src/deno_index.ts
// 或 deno.json: { "tasks": { "start": "deno run --allow-net --allow-env --allow-read src/deno_index.ts" } }
if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve({ port }, handler);
} else {
  // 兼容旧版 Deno 1.x
  const server = Deno.listen({ port });
  for await (const conn of server) {
    const httpConn = Deno.serveHttp(conn);
    for await (const event of httpConn) {
      event.respondWith(handler(event.request));
    }
  }
}
