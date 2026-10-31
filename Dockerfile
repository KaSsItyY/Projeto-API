FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /app

RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /opt/yarn*

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY sql ./sql
COPY src ./src

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
