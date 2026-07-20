// src/deno_index.ts - 网页镜像代理版（适用于浏览器直接访问）

const TARGET_URL = "https://grok.com";
const ORIGIN_DOMAIN = "grok.com";

const AUTH_USERNAME = Deno.env.get("AUTH_USERNAME");
const AUTH_PASSWORD = Deno.env.get("AUTH_PASSWORD");
// 注意：环境变量键名必须是全小写的 "cookie"
const COOKIE = Deno.env.get("cookie"); 

function isValidAuth(authHeader: string): boolean {
  try {
    const base64Credentials = authHeader.split(" ")[1];
    const credentials = atob(base64Credentials);
    const [username, password] = credentials.split(":");
    return username === AUTH_USERNAME && password === AUTH_PASSWORD;
  } catch {
    return false;
  }
}

async function handleWebSocket(req: Request): Promise<Response> {
  const { socket: clientWs, response } = Deno.upgradeWebSocket(req);
  const url = new URL(req.url);
  const targetUrl = `wss://grok.com${url.pathname}${url.search}`;

  const pendingMessages: string[] = [];
  const targetWs = new WebSocket(targetUrl);

  targetWs.onopen = () => {
    pendingMessages.forEach(msg => targetWs.send(msg));
    pendingMessages.length = 0;
  };

  clientWs.onmessage = (event) => {
    if (targetWs.readyState === WebSocket.OPEN) targetWs.send(event.data);
    else pendingMessages.push(event.data);
  };

  targetWs.onmessage = (event) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(event.data);
  };

  clientWs.onclose = (event) => {
    if (targetWs.readyState === WebSocket.OPEN) targetWs.close(1000, event.reason);
  };

  targetWs.onclose = (event) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(event.code, event.reason);
  };

  targetWs.onerror = (error) => {
    console.error('WebSocket error:', error);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, "Target WebSocket error");
  };

  return response;
}

const handler = async (req: Request): Promise<Response> => {
  // Basic Auth 验证
  const authHeader = req.headers.get("Authorization");
  if (AUTH_USERNAME && AUTH_PASSWORD && (!authHeader || !isValidAuth(authHeader))) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Protected"' } });
  }

  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

  const url = new URL(req.url);
  const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

  const headers = new Headers(req.headers);
  headers.set("Host", targetUrl.host);
  headers.delete("Referer");
  headers.delete("Authorization");
  headers.delete("Cookie");
  if (COOKIE) {
    headers.set("Cookie", COOKIE); // 注入你的 Cookie
  }

  try {
    const proxyResponse = await fetch(targetUrl.toString(), {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });

    const responseHeaders = new Headers(proxyResponse.headers);
    responseHeaders.delete("Content-Length");
    const location = responseHeaders.get("Location");
    if (location) {
      responseHeaders.set("Location", location.replace(TARGET_URL, `https://${ORIGIN_DOMAIN}`));
    }

    if ([204, 205, 304].includes(proxyResponse.status)) {
      return new Response(null, { status: proxyResponse.status, headers: responseHeaders });
    }

    const transformStream = new TransformStream({
      transform: async (chunk, controller) => {
        const contentType = responseHeaders.get("Content-Type") || "";
        if (contentType.startsWith("text/") || contentType.includes("json")) {
          let text = new TextDecoder("utf-8", { stream: true }).decode(chunk);
          controller.enqueue(new TextEncoder().encode(text.replaceAll(TARGET_URL, ORIGIN_DOMAIN)));
        } else {
          controller.enqueue(chunk);
        }
      }
    });

    const readableStream = proxyResponse.body?.pipeThrough(transformStream);
    return new Response(readableStream, { status: proxyResponse.status, headers: responseHeaders });
  } catch (error) {
    return new Response(`Proxy Error: ${error.message}`, { status: 500 });
  }
};

// 直接在 Deno Deploy 上运行的启动入口
Deno.serve(handler);
