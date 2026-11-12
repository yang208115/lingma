FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile \
    && pnpm build \
    && pnpm --filter @lingma/server deploy --prod --legacy /out/apps/server

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/.data
WORKDIR /app
COPY LICENSE ./LICENSE
COPY --from=build /out/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /out/apps/server/package.json ./apps/server/package.json
COPY --from=build /out/apps/server/dist ./apps/server/dist
COPY --from=build /build/apps/web/dist ./apps/web/dist
RUN mkdir /app/.data && chown node:node /app/.data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
