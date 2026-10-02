# goose-web container image — multi-stage build.
#
# Stage 1 builds the static SPA with npm ci (lockfile pinned). The SDK ships
# compiled dist/ output, so no cross-repo build steps are needed here.
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app

# Reproducible install from the lockfile only.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# Stage 2 serves the SPA. The stock nginx entrypoint envsubsts
# nginx/default.conf.template (substituting only GOOSE_API_URL) into the
# default server config, proxies /api to the engine — the admin API sets no
# CORS headers, so same-origin proxying is the supported deployment — and
# falls back to index.html for SPA routes.
FROM docker.io/library/nginx:1.29-alpine
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# The envsubst in the nginx entrypoint replaces ONLY the listed variables;
# without this, it would try to substitute nginx's own $uri/$host runtime
# variables and fail the same way an empty GOOSE_API_URL would.
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d \
    GOOSE_API_URL=http://host.docker.internal:9090

EXPOSE 8080
