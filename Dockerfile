# --- build stage --------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json yarn.lock* ./
COPY relay/package.json relay/tsconfig.json ./relay/
RUN corepack enable && yarn install --frozen-lockfile --ignore-scripts || npm install
COPY relay/src ./relay/src
WORKDIR /app/relay
RUN npx tsc -p tsconfig.json

# --- runtime stage ------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/relay/dist ./dist
COPY --from=build /app/relay/node_modules ./node_modules
COPY --from=build /app/relay/package.json ./package.json
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_PORT||4000)+'/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
