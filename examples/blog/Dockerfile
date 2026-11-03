# [xihanzu-NR]
# A deployable HydraScript app: compiled in one stage, run in another.
#
# The runtime stage carries NO compiler and NO source. `hydra serve` needs
# `dist/`, `.hydra/` and `react`/`react-dom` in node_modules — that is the whole
# contract, and `docs/DEPLOYING.md` is where it is written down.
#
#   docker build -t myapp .
#   docker run -p 3000:3000 --env-file .env myapp

FROM node:22-bookworm AS build
WORKDIR /app

# Dependencies first, so a source edit does not invalidate the install layer.
COPY package*.json ./
RUN npm ci

COPY . .

# `--target node` keeps the server half: API routes, middleware, loaders,
# actions and server rendering for dynamic routes. A static build would drop
# them and say so, loudly, in the log.
RUN npx hydrascript build --target node

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The artifact, and nothing that produced it.
COPY --from=build /app/dist ./dist
COPY --from=build /app/.hydra ./.hydra
COPY --from=build /app/hydraconfig.json ./hydraconfig.json
COPY --from=build /app/package*.json ./

# Production dependencies only. The server bundle requires react and react-dom
# at runtime; everything else in devDependencies stayed in the build stage.
RUN npm ci --omit=dev && npm cache clean --force

# Not root: nothing in this image needs to write to disk at runtime.
RUN useradd --system --uid 10001 --create-home app && chown -R app:app /app
USER app

EXPOSE 3000
# `--host 0.0.0.0` is deliberate: inside a container, loopback is unreachable
# from outside. Everywhere else the default stays 127.0.0.1.
CMD ["npx", "hydrascript", "serve", "--host", "0.0.0.0", "--port", "3000"]
