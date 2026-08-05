FROM node:22-bookworm-slim AS build

WORKDIR /workspace

COPY sdk/package.json sdk/package-lock.json ./sdk/
RUN npm ci --prefix sdk
COPY sdk ./sdk
RUN npm run build --prefix sdk

COPY services/zendesk-gateway/package.json services/zendesk-gateway/package-lock.json ./services/zendesk-gateway/
RUN npm ci --prefix services/zendesk-gateway
COPY services/zendesk-gateway ./services/zendesk-gateway
RUN npm run build --prefix services/zendesk-gateway

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /workspace/sdk/package.json ./sdk/package.json
COPY --from=build /workspace/sdk/dist ./sdk/dist
COPY --from=build /workspace/services/zendesk-gateway/package.json ./services/zendesk-gateway/package.json
COPY --from=build /workspace/services/zendesk-gateway/package-lock.json ./services/zendesk-gateway/package-lock.json
RUN npm ci --omit=dev --prefix services/zendesk-gateway \
  && npm cache clean --force

COPY --from=build /workspace/services/zendesk-gateway/dist ./services/zendesk-gateway/dist
COPY --from=build /workspace/services/zendesk-gateway/migrations ./services/zendesk-gateway/migrations

USER node
WORKDIR /app/services/zendesk-gateway
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
