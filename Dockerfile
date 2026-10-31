# ОРБИТА — образ приложения.
# У проекта нет npm-зависимостей (HTTP-сервер и драйвер PostgreSQL написаны на чистом Node.js),
# поэтому образ собирается за секунды и не ходит в интернет за пакетами.
FROM node:22-alpine

LABEL org.opencontainers.image.title="ОРБИТА" \
      org.opencontainers.image.description="Информационная система центра управления полётами" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# Файлы принадлежат root и доступны только на чтение: процесс приложения не может изменить свой код.
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server/index.js"]
