// probe-models.mjs - 一次性探测脚本
// 测试 Grok.com 上各种可能的模型清单端点

const COOK = Deno.env.get("TEST_COOKIE") || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const endpoints = [
  // Google 风格的 REST 资源端点
  "https://grok.com/v1/models",
  "https://grok.com/v1beta/models",
  "https://grok.com/api/v1/models",
  "https://grok.com/rest/v1/models",
  // Grok 内部 REST 风格
  "https://grok.com/rest/models",
  "https://grok.com/rest/app/models",
  "https://grok.com/rest/app-chat/models",
  "https://grok.com/rest/models/list",
  "https://grok.com/rest/app-chat/models/list",
  "https://grok.com/rest/conversations/models",
  // i/ 路径 (grok.com 网页版 next.js 路由)
  "https://grok.com/i/api/models",
  "https://grok.com/i/models",
  // 备用路径
  "https://grok.com/api/models",
  "https://grok.com/models",
];

for (const ep of endpoints) {
  try {
    const res = await fetch(ep, {
      method: "GET",
      headers: {
        "user-agent": UA,
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-GB,en;q=0.9",
        ...(COOK && { cookie: COOK }),
      },
      redirect: "manual",
    });
    const ct = res.headers.get("content-type") || "";
    const text = (await res.text()).slice(0, 300).replace(/\n/g, " ");
    console.log(`${res.status} [${ct.split(";")[0]}] ${ep}`);
    console.log(`  ${text}`);
  } catch (e) {
    console.log(`ERR ${ep}: ${e.message}`);
  }
}