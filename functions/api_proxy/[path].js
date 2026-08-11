// Cloudflare Pages Functions 入口文件
// 把请求转发到 worker.mjs 的 fetch handler

import worker from "./worker.mjs";

export async function onRequest(context) {
  const { request, env } = context;
  return worker.fetch(request, env);
}