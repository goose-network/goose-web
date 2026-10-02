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
```

## Layout

| Path                  | What it shows / edits                                     |
| --------------------- | --------------------------------------------------------- |
| `/` (Overview)        | engine status summary                                      |
| `/engine`             | engine config (log level, metrics window, admin auth, ...) |
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
