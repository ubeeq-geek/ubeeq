FROM node:22-bookworm-slim

WORKDIR /opt/ubeeq
COPY . .
RUN npm ci && npm run build --workspace @ubeeq/adapter-local && npm run build --workspace @ubeeq/reference-api

ENV NODE_ENV=production
