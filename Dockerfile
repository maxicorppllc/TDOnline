# TD Online: game server + built client on one port ($PORT, default 8787).
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server/index.ts"]
