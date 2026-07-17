// 注意：无需再导入 serve，直接使用 Deno 原生标准

const TARGET_URL = "https://grok.com";
const ORIGIN_DOMAIN = "grok.com";

const AUTH_USERNAME = Deno.env.get("AUTH_USERNAME");
const AUTH_PASSWORD = Deno.env.get("AUTH_PASSWORD");

// 注意：这里严格对应用户环境变量里的键名，请务必在设置里写成小写 "cookie"
const COOKIE = Deno.env.get("cookie"); 

// Basic Auth 认证函数
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

  console.log('Target WebSocket URL:', targetUrl);

  const pendingMessages: string[] = [];
  const targetWs = new WebSocket(targetUrl);

  targetWs.onopen = () => {
    console.log('已连接到 grok WebSocket');
    pendingMessages.forEach(msg => targetWs.send(msg));
    pendingMessages.length = 0;
  };

  clientWs.onmessage = (event) => {
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(event.data);
    } else {
      pendingMessages.push(event.data);
    }
  };

  targetWs.onmessage = (event) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(event.data);
    }
  };

  clientWs.onclose = (event) => {
    console.log('客户端 WebSocket 已断开');
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close(1000, event.reason);
    }
  };

  targetWs.onclose = (event) => {
    console.log('目标 WebSocket 已断开');
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(event.code, event.reason);
    }
  };

  targetWs.onerror = (error) => {
    console.error('目标 WebSocket 发生错误:', error);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, "目标 WebSocket 错误");
    }
  };

  return response;
}

const handler = async (req: Request): Promise<Response> => {
  // 1. 基础验证
  const authHeader = req.headers.get("Authorization");
  if (AUTH_USERNAME && AUTH_PASSWORD && (!authHeader || !isValidAuth(authHeader))) {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Proxy Authentication Required"',
      },
    });
  }

  // 2. WebSocket 请求处理
  if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return handleWebSocket(req);
  }

  // 3. 代理 HTTP 请求
  const url = new URL(req.url);
  const targetUrl = new URL(url.pathname + url.search, TARGET_URL);

  const headers = new Headers(req.headers);
  headers.set("Host", targetUrl.host);
  headers.delete("Referer");
  headers.delete("Authorization"); // 不把基本认证头传给 grok

  // 4. 核心修正：只有环境变量里配置了 cookie，才显式设置进去
  headers.delete("Cookie"); 
  if (COOKIE) {
    headers.set("Cookie", COOKIE);
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

    // 替换 Location 跳转
    const location = responseHeaders.get("Location");
    if (location) {
      responseHeaders.set("Location", location.replace(TARGET_URL, `https://${ORIGIN_DOMAIN}`));
    }

    // 处理无内容的返回
    if ([204, 205, 304].includes(proxyResponse.status)) {
      return new Response(null, { status: proxyResponse.status, headers: responseHeaders });
    }

    // 5. 流式替换 TARGET_URL (处理前端页面里的硬编码链接)
    const transformStream = new TransformStream({
      transform: async (chunk, controller) => {
        const contentType = responseHeaders.get("Content-Type") || "";
        if (contentType.startsWith("text/") || contentType.includes("json")) {
          let text = new TextDecoder("utf-8", { stream: true }).decode(chunk);
          controller.enqueue(
            new TextEncoder().encode(text.replaceAll(TARGET_URL, ORIGIN_DOMAIN))
          );
        } else {
          controller.enqueue(chunk);
        }
      }
    });

    const readableStream = proxyResponse.body?.pipeThrough(transformStream);

    return new Response(readableStream, {
      status: proxyResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("代理请求出错:", error);
    return new Response(`Proxy Error: ${error.message}`, { status: 500 });
  }
};

// ✅ 关键修改：使用 Deno 原生 API 启动服务，完美适配 Deno Deploy
Deno.serve(handler);
