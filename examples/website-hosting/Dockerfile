FROM node:24-bookworm-slim
WORKDIR /opt/ubeeq
# Run npm run build && npm run package:lambda --workspace @ubeeq/reference-api first.
# Packaging on the same architecture/libc includes the approved Sharp platform binary.
COPY --chown=node:node apps/reference-api/lambda-package/ ./
ENV NODE_ENV=production
USER node
CMD ["node","website-server.js"]
