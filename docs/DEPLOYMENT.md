# Deployment

## Where everything runs

| Component | Host | URL | Plan | Catch |
|---|---|---|---|---|
| Frontend | Cloudflare Workers (static assets) | https://document-info-retriever.souravkr-62.workers.dev | Free | none |
| Backend | Render (Web Service) | https://document-info-retriever.onrender.com | Free | sleeps after 15 min idle, ~50 s cold start |
| Database | Supabase (Postgres 17 + pgvector) | session pooler, port 5432 | Free | pauses after 7 days idle |
| Embeddings + LLM | Google Gemini API | — | Free tier | aggressive rate limits |
| Source | GitHub | https://github.com/Sourav-Kumar-bit/Document-Info-Retriever | — | monorepo: `client/` + `server/` |

---

## Environment variables

### Backend — set in the Render dashboard

Render does **not** read `server/.env`. That file only affects local runs.
Everything below must be entered under **Settings → Environment**.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | yes | — | From Google AI Studio |
| `DB_HOST` | yes | — | **Must be the pooler host**, see below |
| `DB_PORT` | no | `5432` | Use 5432 (session pooler), not 6543 |
| `DB_NAME` | no | `postgres` | |
| `DB_USER` | yes | `postgres` | **`postgres.<project-ref>`** for the pooler |
| `DB_PASSWORD` | yes | — | Supabase database password |
| `ALLOWED_ORIGINS` | no | `http://localhost:4200` | Comma-separated, no spaces, no trailing slash |
| `MAX_UPLOAD_MB` | no | `50` | Currently set to `20` |
| `MAX_PAGES` | no | `400` | The real safety valve |
| `MAX_DOCS_PER_SESSION` | no | `5` | |
| `EMBED_BATCH` | no | `50` | Lower to 25 if you see repeated 429 retries |

Current `ALLOWED_ORIGINS` value:

```
http://localhost:4200,https://document-info-retriever.souravkr-62.workers.dev
```

### Why the pooler host

Supabase's direct host `db.<project-ref>.supabase.co` is **IPv6-only** on the
free tier. It works from a home connection with IPv6 and fails from Render,
whose outbound network is IPv4-only. The failure is a connection timeout that
looks like a firewall problem.

Use the session pooler instead — from **Connect → Session pooler**:

```
DB_HOST=aws-0-<region>.pooler.supabase.com
DB_PORT=5432
DB_USER=postgres.<project-ref>          ← note the dot and project ref
```

**Avoid the transaction pooler on port 6543.** It does not support prepared
statements, which psycopg uses by default, producing intermittent errors that
are painful to diagnose.

### Passwords with special characters

Connection parameters are passed as a dict, not a URI, specifically to avoid
escaping problems:

```python
DB_CONFIG = {"host": ..., "port": ..., "dbname": ..., "user": ..., "password": ...}
psycopg.connect(**DB_CONFIG)
```

A password containing `@` breaks a URI (the parser splits on the last `@` and
reads the rest as the hostname). With separate parameters, no escaping is ever
needed.

### Frontend — baked in at build time

There are no runtime environment variables. The API URL is compiled into the
bundle from `src/environments/`.

| File | Used by | Value |
|---|---|---|
| `environment.ts` | `ng build` (production) | `https://document-info-retriever.onrender.com` |
| `environment.development.ts` | `ng serve` | same, deliberately |

Read the direction carefully: `environment.ts` is the **production** file, and
`angular.json`'s development configuration replaces it with the `.development`
one. Development points at the deployed backend on purpose, so CORS, cold
starts and real latency show up while they are cheap to fix.

To debug the backend locally, change `apiUrl` in `environment.development.ts`
to `http://localhost:8000`.

### Local `.env` template

`server/.env` — never committed:

```ini
GEMINI_API_KEY=your_key_here

DB_HOST=aws-0-ap-south-1.pooler.supabase.com
DB_PORT=5432
DB_NAME=postgres
DB_USER=postgres.<project-ref>
DB_PASSWORD=your_password

ALLOWED_ORIGINS=http://localhost:4200
MAX_UPLOAD_MB=20
MAX_PAGES=400
MAX_DOCS_PER_SESSION=5
EMBED_BATCH=50
```

---

## Backend: Render

### Service configuration

| Setting | Value |
|---|---|
| Root Directory | `server` |
| Language | Python 3 |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Instance Type | Free (512 MB RAM) |
| Branch | `main` |

`--host 0.0.0.0` and `$PORT` are both mandatory. The default `127.0.0.1` only
accepts connections from inside the container, and the port is assigned by the
platform.

### Deploying

Auto-deploy is on. Pushing to `main` rebuilds — but only when files inside
`server/` change, because Root Directory scopes the trigger. Frontend-only
pushes will not rebuild the backend, which is correct but looks like nothing
happened.

Changing an environment variable also triggers a redeploy.

Takes 2–4 minutes. Success looks like:

```
Uvicorn running on http://0.0.0.0:10000
==> Your service is live 🎉
```

### Why Render rather than Cloud Run

Render does not CPU-throttle between requests, so FastAPI `BackgroundTasks`
actually finish. On Cloud Run the container is frozen the moment a response is
sent, and background ingestion silently stalls unless you set minimum instances
to 1 or `--no-cpu-throttling`.

### Memory

512 MB total. A 20 MB PDF holds the raw bytes, the parsed document, extracted
text, and all embedding vectors in memory simultaneously — roughly 120–150 MB
resident. Comfortable. At 50 MB it would be tight, which is why the limit is 20.

If ingestion dies silently on a large file, memory is the cause. The fix is
inserting chunks to Postgres in batches as they are embedded, rather than
accumulating every vector first.

---

## Frontend: Cloudflare Workers

Cloudflare merged Pages into Workers. Static sites now deploy as a Worker with
static assets, configured by a file in the repo rather than dashboard fields.

### `client/wrangler.jsonc`

```jsonc
{
  "name": "document-info-retriever",
  "compatibility_date": "2026-09-14",
  "assets": {
    "directory": "./dist/document-info-retriever/browser",
    "not_found_handling": "single-page-application"
  },
  "observability": { "enabled": true }
}
```

`directory` is relative to this file, which lives in `client/`. The `browser`
subfolder is not optional — Angular 17+ writes there, and pointing at the parent
deploys a directory containing only a folder, so every request 404s while the
build log says "success".

`not_found_handling: "single-page-application"` serves `index.html` for any
unmatched path. This is the SPA fallback and it replaces the `_redirects` file
used by the old Pages flow.

### Deploying from your machine

The reliable path:

```powershell
cd client
ng build
npx wrangler deploy
```

Opens a browser to authenticate the first time, then uploads. About a minute.

### Deploying from Git

| Setting | Value |
|---|---|
| Root directory | `client` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |
| `NODE_VERSION` | `22` (build-time variable) |

If the root directory setting is not applied by the build runner — the symptom
is `ENOENT ... /opt/buildhome/repo/package.json`, with no `client/` in the path
— fold it into the commands instead:

```
Build command:   cd client && npm ci && npm run build
Deploy command:  cd client && npx wrangler deploy
```

`npm ci` is necessary there because Cloudflare's install step already ran and
found nothing.

**Trigger rebuilds with a push, not "Retry deployment."** Retry replays a
deployment with the settings it originally had, so configuration changes appear
to do nothing.

```powershell
git commit --allow-empty -m "trigger build"
git push
```

### Build budgets

`angular.json` raises the component style budget, because `chat.scss` is 9 kB:

```json
{ "type": "anyComponentStyle", "maximumWarning": "12kB", "maximumError": "20kB" }
```

The default 8 kB error threshold fails the build. Component styles are inlined
into the JS bundle, which is why Angular nudges you to keep them small; 9 kB raw
is about 2 kB gzipped and not a real cost.

---

## Database: Supabase

Schema is in [ARCHITECTURE.md](ARCHITECTURE.md#database-schema) — run it once in
the SQL editor.

When creating tables, Supabase warns about Row Level Security. **Run without
RLS** is correct here: RLS protects against browsers holding an anon key, and
nothing reaches this database except FastAPI over a direct connection as the
`postgres` role, which bypasses RLS regardless. See ARCHITECTURE.md for the
condition under which this must be revisited.

### The pause problem

Free projects are suspended after 7 days of inactivity, and the backend then
fails with connection errors that look like a deploy problem. Either log in
weekly, or migrate to Neon, which does not pause.

---

## Changing a limit

Example: raising the upload limit to 30 MB.

1. Render → Environment → `MAX_UPLOAD_MB` = `30` → Save
2. Wait for the redeploy
3. Confirm: `GET /limits` returns `{"max_upload_mb": 30, ...}`

**No frontend change is needed.** The uploader reads its threshold from
`/limits`, so the copy and the pre-flight check both follow automatically.

---

## Full redeploy checklist

```
Backend
  □ git push (files under server/ changed)
  □ Render logs show "Your service is live"
  □ GET /health returns {"status":"ok"}
  □ GET /limits returns the expected numbers

Frontend
  □ cd client && ng build         (check for budget errors)
  □ npx wrangler deploy
  □ Hard-reload the site (Ctrl+Shift+R) — favicons and JS cache hard

CORS
  □ ALLOWED_ORIGINS contains the exact frontend origin
  □ no trailing slash, no spaces, https not http

Smoke test on a phone
  □ upload a PDF                  (expect ~50 s cold start)
  □ status reaches ready
  □ a question returns cited page numbers
  □ "explain that more simply" shows the "Searched for…" line
  □ theme persists across reload
  □ a private window shows no documents
```
