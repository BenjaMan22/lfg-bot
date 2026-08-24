# Builder: installs devDependencies too (needed for tsc) and compiles.
FROM node:26-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime: only production dependencies and the compiled output land here,
# so TypeScript, vitest, and tsx never ship in the image that actually runs.
FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
# dist/src/db/schema.sql is copied alongside dist/src/index.js by `npm run
# build` (see package.json), so pulling the whole dist/ tree carries it —
# openDatabase() needs it at that exact path.
COPY --from=builder /app/dist ./dist
# node:26-alpine ships an unused, unprivileged "node" user (uid 1000). Run as
# that instead of root. This means ./data on the host must be writable by
# uid 1000 — see compose.yaml and the README's deployment section.
USER node
CMD ["node", "dist/src/index.js"]
