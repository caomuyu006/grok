# Grok 3 API Proxy

> 使用 Deno 代理 Grok 3，提供 OpenAI 兼容 API，国内直连，不限地区/不限网络/不限设备。

**核心架构**：参照 [gemini-main](https://github.com/trueai-org/grok)（trueai-org 作品）设计，将 Grok 网页版 REST API (`/rest/app-chat/conversations/new`) 转换为标准 OpenAI 兼容端点 (`/v1/chat/completions`)，可直接接入 Cherry Studio、ChatBox、Cursor、Cline 等主流 AI 客户端。

本项目由原 Node.js 版升级为 **Deno 原生**，支持直接部署到 **Deno Deploy**（免费边缘计算平台，海外节点）。

## 核心特点

- **OpenAI 兼容端点**：`/v1/chat/completions`、`/v1/models`、`/health`
- **两种认证模式**：
  - ✅ **Cookie 模式**（推荐）：注入 grok.com 浏览器 Cookie，稳定性更高
  - ✅ **匿名免登录模式**：自动从 grok.com 获取匿名身份 Cookie，无 Cookie 也能用
- **SSE 流式响应**：支持 `stream: true`，NDJSON → SSE 实时输出
- **多模型**：`grok-3`、`grok-3-reasoning`、`grok-3-mini`、`grok-3-fast`
- **可选 Basic Auth**：通过 `AUTH_USERNAME`/`AUTH_PASSWORD` 保护 API
- **跨域全开放**：CORS `Access-Control-Allow-Origin: *`

## 快速开始

### 方式一：Cloudflare Workers 部署（推荐·免费·永久在线）

Cloudflare Workers 免费额度：每天 100,000 请求，全球节点，IP 信誉高，可绕过 grok.com 反爬虫拦截。

**Step 1：登录 Cloudflare**
打开 https://dash.cloudflare.com → 左侧 Compute → Workers & Pages → Create application → Create Worker

**Step 2：填个名字**
例如 `grok-proxy`，点 Deploy 进入代码编辑页

**Step 3：粘贴代码**
将 `src/api_proxy/worker.mjs` 全文内容粘贴到 Cloudflare 编辑器（覆盖默认代码）。该文件已是 Cloudflare Worker 兼容格式（`export default { async fetch(req, env) {} }`）。

**Step 4：设置环境变量**
代码编辑页右侧 Settings → Variables and Secrets → Add
- Variable name: `GROK_COOKIE`
- Value: 你的 grok.com 浏览器 Cookie（推荐包含 `sso=` 和 `sso-rw=`）
- 点 Encrypt 加密保存 → Deploy

**Step 5：测试**
浏览器访问 `https://grok-proxy.<你的子域>.workers.dev/v1/models`，看到 JSON 列表即成功。

**获取 cookie 步骤**：
1. 浏览器打开 https://grok.com 并登录账号
2. F12 → Application → Cookies → 复制 `sso` 和 `sso-rw` 的值
3. 格式：`sso=eyJ...; sso-rw=eyJ...`（分号分隔）

### 方式二：Deno Deploy 部署（免费但可能被反爬虫拦截）

Deno Deploy 是 Deno 官方边缘计算平台，有免费额度，海外节点可直连 grok.com。

**Step 1：上传到 GitHub**

```bash
cd grok-main
git init
git add -A
git commit -m "Initial commit"
# 在 GitHub 创建同名空仓库后:
git remote add origin https://github.com/YOUR_USERNAME/grok-main.git
git push -u origin master
```

**Step 2：关联 Deno Deploy**

1. 访问 [deno.com/deploy](https://deno.com/deploy)
2. 用 GitHub 账号登录
3. New Project → Connect GitHub Repository → 选择 `grok-main` 仓库
4. Configure：Entry Point → `src/deno_index.ts`；Environment Variables 添加 `GROK_COOKIE`（可选）
5. 点击 Deploy

部署后 Deno Deploy 会提供类似 `xxx.deno.dev` 的免费域名，可在国内直接访问！

**或用 CLI 部署（无需 GitHub）：**

```bash
deno run -A jsr:@deno/deploy deploy src/deno_index.ts
```

### 方式二：Docker 部署

```bash
docker compose up -d
```

### 方式三：本地 Deno 运行

```bash
deno run --allow-net --allow-env --allow-read src/deno_index.ts
# 或带 Cookie：
GROK_COOKIE="sso=ey...; sso-rw=ey..." deno run --allow-net --allow-env --allow-read src/deno_index.ts
# 或带 Basic Auth：
AUTH_USERNAME=admin AUTH_PASSWORD=changeme deno run --allow-net --allow-env --allow-read src/deno_index.ts
```

Windows 用户双击 `start.bat` 即可（需先安装 Deno，见下文）。

#### 安装 Deno（Windows）

```powershell
irm https://deno.com/install.ps1 | iex
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `8000` |
| `GROK_COOKIE` | Grok Cookie（格式：`sso=ey...; sso-rw=ey...`） | 匿名模式 |
| `AUTH_USERNAME` | Basic Auth 用户名（不设置则跳过验证） | 无 |
| `AUTH_PASSWORD` | Basic Auth 密码 | 无 |

## 获取 Grok Cookie（可选）

1. 浏览器登录 [grok.com](https://grok.com)
2. 按 `F12` → **Application** → **Cookies** → `https://grok.com`
3. 复制 `sso` 和 `sso-rw` 的值，格式：`sso=ey...; sso-rw=ey...`

> Cookie 有时效性，过期后重新获取即可。匿名模式无需 Cookie，但 QPS 有限制。

## API 使用示例

### curl 测试

```bash
# 非流式
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "grok-3", "messages": [{"role": "user", "content": "Hello"}], "stream": false}'

# 流式
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "grok-3", "messages": [{"role": "user", "content": "写一首诗"}], "stream": true}'
```

### Cherry Studio / ChatBox 配置

- **API 地址**：`http://你的部署地址:8000`（Deno Deploy 填 `https://xxx.deno.dev`）
- **API Key**：任意字符串（如 `grok`），匿名模式无需真实 key
- **模型**：`grok-3` 或 `grok-3-reasoning`

### OpenAI SDK 调用

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "grok",
  baseURL: "https://your-deploy.deno.dev", // 替换为你的 Deno Deploy 域名
});

const chat = await client.chat.completions.create({
  model: "grok-3",
  messages: [{ role: "user", content: "Hello, Grok!" }],
  stream: true,
});

for await (const chunk of chat) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

## 模型说明

| 模型 | 说明 |
|------|------|
| `grok-3` | Grok 3 标准版 |
| `grok-3-reasoning` | Grok 3 推理版（Think 模式） |
| `grok-3-mini` | Grok 3 Mini 轻量版 |
| `grok-3-fast` | Grok 3 Fast 加速版 |

## 项目结构

```
grok-main/
├── src/
│   ├── deno_index.ts      # Deno 入口 (WebSocket 代理 + API 路由)
│   └── api_proxy/
│       └── worker.mjs      # OpenAI→Grok 转换层 (NDJSON→SSE)
├── deno.json               # Deno 配置
├── Dockerfile              # Docker 镜像 (Deno)
├── docker-compose.yml      # Docker Compose 编排
├── start.bat               # Windows 一键启动 (Deno)
└── README.md
```

## 故障排除

| 问题 | 原因 | 解决 |
|------|------|------|
| `502 fetch failed` | 国内直连 grok.com 被墙 | 部署到海外节点（Deno Deploy） |
| `401 Unauthorized` | Basic Auth 验证失败 | 确认 AUTH_USERNAME/PASSWORD |
| `403 / empty response` | Cookie 无效或过期 | 重新获取 grok.com Cookie |
| 匿名模式 QPS 低 | Grok 匿名限流 | 使用 Cookie 模式 |

## 免责声明

本项目为非官方第三方实现，使用 xAI 官方未公开的内部 REST API 接口，存在以下风险：
- 接口因 Grok 官方更新而失效
- 账号被 xAI 封禁
- 请勿用于商业用途

## 参考项目

- [trueai-org/grok](https://github.com/trueai-org/grok)（架构参照）
- [trueai-org/gemini](https://github.com/trueai-org/gemini)（本项目设计来源）
- [GhostXia/grok3_api-Fix](https://github.com/GhostXia/grok3_api-Fix)
- [RoCry/grok3-api-cf](https://github.com/RoCry/grok3-api-cf)
- [mem0ai/grok3-api](https://github.com/mem0ai/grok3-api)
