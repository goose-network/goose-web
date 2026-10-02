# goose-web

Web frontend for the [goose](https://github.com/goose-network/goose)
proxy-pool engine, built on the generated TypeScript SDK
([goose-sdk-ts](https://github.com/goose-network/goose-sdk-ts)).

It manages every engine resource over the admin API — engine config,
inbounds, outbounds, pools, chains — and renders a metrics dashboard for
recent proxied requests.

## Stack

- [React 19](https://react.dev) + [React Router 7](https://reactrouter.com)
- [Vite 7](https://vite.dev), TypeScript strict mode
- `@goose-network/goose-sdk` (installed from the goose-sdk-ts GitHub repo;
  the SDK ships compiled `dist/` output, so no build step is needed on install)
- Charts are dependency-free SVG components (`src/charts/`), following the
  dataviz rules: validated palette with light/dark modes, table-view twin
  under every chart, crosshair tooltips on lines, per-mark hover on bars.

## Run it

```sh
npm install
npm run dev        # vite dev server on http://localhost:5173
```

The goose admin API sets no CORS headers, so in dev Vite proxies `/api`
to the engine. Point it at your engine with `GOOSE_API_URL`
(defaults to `http://127.0.0.1:9090`):

```sh
GOOSE_API_URL=http://127.0.0.1:9090 npm run dev
```

In the app, the connection banner (top right) sets the base URL and an
optional bearer token; settings persist in `localStorage`. An empty base
URL means same-origin — the dev proxy or a co-deployed static build
serving the API under the same origin.

## Build & test

```sh
npm run build      # tsc -b && vite build -> dist/
npm run preview    # serve the production build locally
npm test           # vitest (pure helpers: formatting, bucketing, bar folding)
npm run e2e        # Playwright against a running stack (see below)
```

## End-to-end tests

`e2e/run-e2e.mjs` drives the real UI in headless Chromium against a live
engine: connection banner, config-sourced inbound listing, inbound
create/delete through the UI, the engine config form, and the metrics
dashboard. It expects:

- the app built and served (`npm run build && npm run preview`, port 4173)
- a goose engine whose admin API is reachable **through the app's `/api`
  proxy** (in dev/preview Vite handles this), and an HTTP inbound on
  `127.0.0.1:18080` for the metrics test's proxied request

```sh
GOOSE_API_URL=http://127.0.0.1:9090 npx vite preview --port 4173 &
E2E_BASE_URL=http://127.0.0.1:4173 node e2e/run-e2e.mjs
```

CI runs the same thing: it builds the engine from the goose repo, starts
it with a fixed config, serves the built app, and runs the script. The
script imports `playwright-core` and uses whatever Chromium Playwright
has installed (`npx playwright install chromium` if none).

## Container image

`Dockerfile` builds the SPA (node:22-alpine) and serves it with nginx
(`nginx.conf`) on port 8080. nginx proxies `/api` to the engine —
`GOOSE_API_URL`, default `http://127.0.0.1:9090` — and falls back to
`index.html` for SPA routes, so the container works with an empty
base-URL connection (same origin). CI builds, smoke-tests, and pushes
the image to `ghcr.io/goose-network/goose-web` on every push to main.

```sh
docker run -p 8080:8080 -e GOOSE_API_URL=http://host.docker.internal:9090 \
  ghcr.io/goose-network/goose-web:latest
```

## Layout

| Path                  | What it shows / edits                                       |
| --------------------- | --------------------------------------------------------- |
| `/` (Overview)        | engine config (network stack, metrics DB, admin auth, ...)  |
| `/inbounds`           | HTTP/SOCKS5 listeners CRUD                                 |
| `/outbounds`          | outbound protocol plugins CRUD                             |
| `/pools`              | pools (outbound sets + filters + selector) CRUD             |
| `/chains`            | request chains (pool layers) CRUD                          |
| `/metrics`            | request dashboard: KPI tiles, volume/latency trends, per-inbound volume, top targets, raw table |

| File                       | Role                                                |
| -------------------------- | ---------------------------------------------------- |
| `src/sdk.tsx`              | `Goose` SDK instance in React context + connection UI |
| `src/useAsync.ts`          | fetch-on-mount hook (reload, held render on refresh)  |
| `src/format.ts`            | duration / count / time display helpers               |
| `src/charts/*`             | LineChart, BarChart, StatTile + palette                |
| `src/pages/*`             | one panel per resource                                 |
| `src/components/*`         | StringList, KvEditor form widgets                     |
