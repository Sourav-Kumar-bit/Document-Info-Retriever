# Troubleshooting

Every failure actually hit while building this, and what fixed it.

---

## Backend

### `operator does not exist: vector <=> double precision[]`

**Cause.** A Python list was passed as the query vector. psycopg adapts it to a
Postgres array, and `<=>` is only defined for `vector <=> vector`.

Inserts worked because Postgres applies an *assignment cast* when writing to a
`vector` column. Operator resolution does not, which is why the bug stayed
hidden until the first question.

**Fix.** `db.to_vector()` renders the list as pgvector's text format
(`'[0.1,0.2,...]'`) and every query casts explicitly:

```sql
embedding <=> %s::vector
```

### Connection timeout from Render, works locally

**Cause.** `db.<project-ref>.supabase.co` is IPv6-only on Supabase's free tier.
Your home connection has IPv6; Render's outbound network does not.

**Fix.** Use the session pooler:

```ini
DB_HOST=aws-0-<region>.pooler.supabase.com
DB_PORT=5432
DB_USER=postgres.<project-ref>       # note the dot
```

Not the transaction pooler on 6543 — it breaks psycopg's prepared statements.

### `no pq wrapper available` / `No module named 'psycopg_binary'`

**Cause.** `psycopg` installed without the `[binary]` extra. PowerShell also
swallows the square brackets unless quoted.

**Fix.**

```powershell
python -m pip install "psycopg[binary]"
```

### `GEMINI_API_KEY not found` when the .env clearly has it

Three causes, in order of likelihood:

1. **The file is `.env.txt`.** Windows Explorer hides known extensions. Check
   with `cmd /c dir /a`, where nothing is hidden.
2. **A UTF-8 BOM.** Notepad writes three invisible bytes at the start, so the
   *first* key becomes `\ufeffGEMINI_API_KEY`. Every other key parses fine —
   which is the tell. Fix with `load_dotenv(encoding="utf-8-sig")` or re-save
   as UTF-8 without BOM.
3. **Working directory.** `load_dotenv()` searches from the current directory
   upward, not from the script's location.

### Database URI fails with a valid password

A password containing `@` breaks URI parsing — the parser splits on the last
`@` and reads the rest as the hostname. This project passes connection
parameters as a dict specifically to avoid the problem. If you must use a URI,
percent-encode: `@` → `%40`.

### Document stuck on `processing` forever

Check `documents.error` in the Supabase table editor. If it is null, the
background task died without writing a status — look at the Render logs.

Also confirm ingestion is not simply slow: a 400-page PDF takes 8–15 minutes
with rate-limit backoff. The frontend gives up polling after 15 minutes.

### Repeated `embedding batch failed ... retrying`

Gemini free-tier rate limiting. Lower `EMBED_BATCH` to 25, or 10 if ingestion
still fails after five retries. Do not raise it above 100 — Gemini has a
per-request batch cap and you would get 400s, which backoff cannot help.

### Misleading error messages

An early version wrapped the query route in `except Exception` and reported
"The model service failed" for everything. A SQL type error therefore read as a
Gemini outage and sent debugging in the wrong direction. The handler now reports
the exception type and message. **Errors should describe what happened, not
guess at where.**

---

## Frontend

### Build fails: `exceeded maximum budget`

Component styles are inlined into the JS bundle, so Angular caps any single
component at 4 kB (warning) / 8 kB (error). `chat.scss` is ~9 kB.

**Fix.** In `angular.json`:

```json
{ "type": "anyComponentStyle", "maximumWarning": "12kB", "maximumError": "20kB" }
```

9 kB raw is about 2 kB gzipped — not a real cost for the largest component in
the app.

### Cloudflare build: `ENOENT /opt/buildhome/repo/package.json`

Root directory is not applied, so the build runs at the repo root where there
is no `package.json`.

**Fix.** Set Root directory to `client`. If it still fails — the path in the
error has no `client/` in it — fold it into the commands:

```
Build command:   cd client && npm ci && npm run build
Deploy command:  cd client && npx wrangler deploy
```

**Trigger rebuilds with a push.** "Retry deployment" replays a deployment with
its original settings, so configuration changes appear to do nothing.

```powershell
git commit --allow-empty -m "trigger build"
git push
```

### Site loads but every request fails

Almost always CORS. `/docs` and curl are not browsers and do not enforce it, so
the API can work perfectly in testing and fail from the deployed frontend.

Open DevTools → Console. A CORS error names the blocked origin. Compare it
character by character against `ALLOWED_ORIGINS`: no trailing slash, no spaces
around commas, `https` not `http`.

Cloudflare also issues a unique preview URL per branch and commit. Those are
different origins and will each fail CORS. Test on the production URL.

### Blank page, build "succeeded"

The assets directory points at `dist/<name>` instead of `dist/<name>/browser`,
so the deployed root contains only a folder and has no `index.html`.

### View doesn't update after an HTTP response

Angular 22 is zoneless with OnPush. A plain class field assigned in a callback
updates the object but never re-renders — silently, with no error.

**Fix.** All state must be signals.

```ts
// wrong
this.documents = docs;

// right
this.documents.set(docs);
```

### Old favicon persists

Favicons cache aggressively. Hard-reload with Ctrl+Shift+R, or they survive for
days.

### `Set-ExecutionPolicy` blocks venv activation

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
.\venv\Scripts\Activate.ps1
```

`Activate.ps1` is the PowerShell script — running the extensionless `activate`
through Python produces a shell-script syntax error.

### VS Code shows import errors but the code runs

Wrong interpreter selected. `Ctrl+Shift+P` → Python: Select Interpreter →
`.\venv\Scripts\python.exe`. Pin it for the workspace:

```json
{ "python.defaultInterpreterPath": "${workspaceFolder}/server/venv/Scripts/python.exe" }
```

---

## Retrieval quality

### "This document doesn't cover that" for a reasonable question

**First check what was retrieved.** The distinction matters:

- Wrong chunks returned → retrieval problem: chunk size, embedding task types, `k`
- Right chunks, bad answer → generation problem: prompt or schema

Without that check you are guessing, and the two have completely different fixes.

### Follow-ups fail

If "explain that more simply" returns `enough_info: false`, the backend is on
pre-rewrite code. That message is an instruction about format, not a question
about content — embedded literally it matches nothing.

Confirm the server has the rewrite step: `GET /limits` should exist, and the
query response should carry `resolved_question`.

### Answers are vaguely wrong across the board

Check that `task_type` is set on both embedders. Gemini's embedding model is
asymmetric — indexing and searching with the same task type puts questions and
passages in mismatched spaces. Search still returns results, just consistently
the wrong ones.

### The bibliography keeps appearing in results

Reference lists are dense with author names and paper titles, so they land near
almost any academic query while containing no usable content. Stripping the
references section during ingestion is usually a bigger win than tuning
`chunk_size`.

---

## Free-tier behaviour that looks like breakage

| Symptom | Cause | Action |
|---|---|---|
| First request takes ~50 s | Render cold start after 15 min idle | Expected; the UI says "waking up" |
| All requests fail after a quiet week | Supabase paused the project | Log into the dashboard to resume |
| Ingestion slow on a big PDF | Gemini rate limits + backoff | Expected; lower `EMBED_BATCH` |
| Backend not rebuilding on push | Render's Root Directory scopes the trigger to `server/` | Correct behaviour |
