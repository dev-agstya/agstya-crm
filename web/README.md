# AgastyaCRM — Web (React + TypeScript)

Vite + React + TypeScript + Tailwind CSS. Talks to the FastAPI backend.

## Setup

```bash
cd web
npm install
cp .env.example .env   # leave VITE_API_BASE_URL empty for local dev (uses proxy)
```

## Run (dev)

```bash
npm run dev            # http://localhost:5173
```

The dev server proxies `/api/*` to `http://localhost:8000`, so start the backend
first (see `server/README.md`).

## Build / preview

```bash
npm run build
npm run preview
```

## Deploy (Vercel)

- Root directory: `web`
- Framework preset: Vite
- Build command: `npm run build`, Output dir: `dist`
- Env var: `VITE_API_BASE_URL` = your Render backend URL (e.g.
  `https://agastyacrm-api.onrender.com`).
- Add a rewrite so client-side routes work (SPA fallback) — `vercel.json` included.

## Structure

```
src/
  api/          axios client (token refresh) + typed endpoints
  store/        zustand auth store
  lib/          types + formatting (money in paise, local-tz dates)
  components/    Icon set, Toast, UI primitives, layout
  pages/         auth/*, Dashboard, Customers, Policies, Leads, Insurers,
                 Commissions, Users, Audit, Settings, PublicUpload
```

## Conventions

- Money is received/sent as integer **paise**; format with `lib/format`.
- Dates are UTC ISO from the API; rendered in the viewer's local timezone.
- Permissions gate UI (`useAuth().has(...)`), but the backend is the real guard.
