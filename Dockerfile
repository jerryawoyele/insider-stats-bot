FROM node:22-alpine AS base

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
RUN npm install -g gmgn-cli

COPY src ./src
COPY README.md ./

CMD ["node", "src/entrypoint.js"]
