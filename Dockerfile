# Grok Proxy (Deno)
FROM denoland/deno:1.45.5

WORKDIR /app

# 复制源码与配置
COPY deno.json ./
COPY src/ ./src/

ENV PORT=8000
ENV NO_COLOR=1

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "src/deno_index.ts"]
