FROM node:22-bookworm-slim

WORKDIR /opt/ubeeq
COPY . .
RUN npm ci && npm run build

ENV NODE_ENV=production
