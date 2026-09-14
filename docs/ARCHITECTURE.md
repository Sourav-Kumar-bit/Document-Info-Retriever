# Architecture

## System map

```
┌────────────────────────────┐
│  Browser                   │
│  Angular 22 SPA            │
│  Cloudflare Workers        │
└─────────────┬──────────────┘
              │ HTTPS + X-Session-Id header
              ▼
┌────────────────────────────┐         ┌──────────────────────────┐
│  FastAPI                   │────────▶│  Gemini API              │
│  Render (free, sleeps)     │         │  embeddings + generation │
└─────────────┬──────────────┘         └──────────────────────────┘
              │ psycopg 3, session pooler :5432
              ▼
┌────────────────────────────┐
│  Postgres 17 + pgvector    │
│  Supabase (free, pauses)   │
│  documents · chunks        │
└────────────────────────────┘
```

The browser never talks to Postgres or Gemini directly. The database connection
string and the Gemini key exist only in the backend's environment.

---

## Two phases

RAG is two separate programs that happen to share a database.

```
INGESTION (once per document, in a background thread)
  PDF bytes → pages → chunks → embeddings → Postgres

QUERY (once per question, in the request)
  question → rewrite → embedding → nearest chunks → prompt → cited answer
```

The `documents.status` column is the only bridge between them. The background
thread writes it; the browser polls it.

---

## Ingestion

Triggered by `POST /documents`. The route returns **202 Accepted** in about
80 ms; the real work happens afterwards in a FastAPI `BackgroundTask`.

```
1  await file.read()                      bytes into memory
2  validate_pdf()                          size, %PDF magic bytes, content-type
3  create_document()                       row with status='processing'
4  return 202 {id}                         ← request ends here
   ─────────────────────────────────────────────────────────────
5  read_pdf()                              pypdf from BytesIO; page cap; encryption check
6  RecursiveCharacterTextSplitter          ~1000 chars, 150 overlap
7  scanned-PDF guard                       total chars < 200 → fail with a message
8  embed_all()                             batches of 50, exponential backoff on 429
9  insert_chunks()                          executemany, one round trip
10 mark_ready(page_count, chunk_count)     status='ready'
```

### Design decisions

**Nothing touches disk.** `PdfReader(io.BytesIO(data))` reads from memory
because Render's filesystem is ephemeral — anything written there disappears on
restart or redeploy. Writing uploads to disk works perfectly in local
development and silently breaks in production.

**`ingest_bytes` must never raise.** It runs in a thread with nobody waiting to
catch it. An uncaught exception would vanish into the logs and leave the
document stuck on `processing` forever. Every failure path writes
`status='failed'` with a message, because that message is what the UI shows.

**The scanned-PDF check is not optional.** Without it, a scan ingests
"successfully" with zero content and every subsequent answer is an unexplained
"not enough information".

**Embedding is batched with backoff.** Gemini's free tier rate-limits hard. A
400-page PDF is roughly 1600 chunks across 32 batches; without retry logic a
single 429 loses the whole ingestion.

### Timing

| Document | Chunks | Roughly |
|---|---|---|
| 15 pages | ~50 | 20–40 s |
| 100 pages | ~400 | 2–4 min |
| 400 pages | ~1600 | 8–15 min |

The frontend polls every 2 seconds and gives up after 15 minutes.

---

## Query

```
POST /documents/{id}/query
  { "question": "...", "history": [{question, answer}, ...] }

1  session + status guards            404 if not yours, 409 if not ready
2  rewrite(question, history)          ← skipped when history is empty
       ↳ standalone_question
       ↳ style
3  query_embeddings.embed_query(standalone_question)    768 floats
4  db.search_chunks()                  cosine distance, filtered by document_id
5  format_context()                    "[0] (page 4)\n..." numbered
6  PROMPT | llm.with_structured_output(Answer)
7  bounds-check the cited indices
8  map indices → page numbers + distances
```

### The rewrite step

This is what makes follow-ups work, and it is the least obvious part of the
system.

Retrieval works by embedding your message and finding similar passages. That is
correct for *"what is multi-head attention?"* and completely wrong for *"answer
in simpler words with an example"* — the second is an instruction about format,
not a question about content. Embedded literally it matches nothing, the model
sees five random chunks, and correctly reports it cannot answer.

The rewrite step splits a message into two independent things:

| Message | standalone_question | style |
|---|---|---|
| "answer in simpler words with an example" | *(previous question, unchanged)* | "brief, simple words, include an example" |
| "why does it help?" | "Why does multi-head attention help?" | null |
| "what are the limitations?" | "what are the limitations?" | null |

Retrieval then runs on `standalone_question`, and `style` is injected into the
answer prompt. One mechanism handles both pronoun resolution and formatting
requests.

It is skipped entirely on the first question — nothing to resolve, no reason to
pay for the call. Any failure falls back to the raw question, so a rewrite
problem degrades to the old behaviour rather than breaking the request.

When the question is rewritten, `resolved_question` comes back in the response
and the UI shows a "Searched for…" line. Without that, a resolved follow-up
looks like the model answered something you never asked.

### Why two embedding models

Gemini's embedding model is **asymmetric**. It was trained so that a question's
vector lands near the vector of a passage that *answers* it — not near the
vector of a similarly-worded question.

```python
document_embeddings = GoogleGenerativeAIEmbeddings(task_type="retrieval_document")
query_embeddings    = GoogleGenerativeAIEmbeddings(task_type="retrieval_query")
```

The index is **built** with the first and **searched** with the second. Using
one for both still returns results — nearest neighbours always exist — but
consistently the wrong ones. This is the single highest-impact line in the
retrieval path.

### Citations

The model never sees a page number it has to remember. It sees numbered chunks
and returns the numbers it used:

```
context:  [0] (page 4) ...   [1] (page 5) ...   [2] (page 2) ...
model:    { "sources": [0, 1] }
server:   results[0]["page"] → 4,  results[1]["page"] → 5
```

The server does the lookup, which is what makes the citation trustworthy rather
than something the model produced. Indices are bounds-checked before use —
never subscript a list with a number an LLM generated.

---

## Database schema

```sql
create extension if not exists vector;

create table documents (
  id          uuid primary key default gen_random_uuid(),
  session_id  text not null,
  filename    text not null,
  status      text not null default 'processing',   -- processing | ready | failed
  error       text,
  page_count  int,
  chunk_count int,
  created_at  timestamptz default now()
);

create table chunks (
  id          bigserial primary key,
  document_id uuid not null references documents(id) on delete cascade,
  chunk_index int  not null,
  page        int,
  content     text not null,
  embedding   vector(768)
);

create index on chunks using hnsw (embedding vector_cosine_ops);
create index on chunks (document_id);
create index on documents (session_id);
```

### Why each choice

**`uuid` for documents, `bigserial` for chunks.** Document ids appear in URLs,
so they must not be guessable. Chunk ids never leave the server, so an integer
is smaller and faster.

**`on delete cascade`** means deleting a document removes its chunks
automatically, so `DELETE /documents/{id}` cannot leave orphans.

**`vector(768)`** must equal `output_dimensionality=768` on the embedder. If
they disagree, inserts fail with a dimension mismatch.

**HNSW with `vector_cosine_ops`** — the operator class must match the query
operator. Build with `vector_cosine_ops` and query with `<->` and Postgres
silently ignores the index and does a full scan. No error, just slow.

**The `chunks(document_id)` index** is what makes per-document filtering fast.
Postgres does not index foreign keys automatically, and missing foreign-key
indexes are one of the most common causes of slow queries.

**Row Level Security is off**, deliberately. RLS protects the database from
browsers holding an anon key. Nothing here reaches Postgres except FastAPI over
a direct connection as the `postgres` role, which bypasses RLS anyway. Access
control is the `where session_id = %s` clause. If you ever add `supabase-js` to
the frontend, this decision must be revisited.

### The vector cast

```sql
select ... embedding <=> %s::vector as distance
```

The `::vector` cast is mandatory. Passing a Python list lets psycopg adapt it to
`double precision[]`, and `<=>` is only defined for `vector <=> vector`.
Inserts still worked without it because Postgres applies an assignment cast on
column assignment — operator resolution does not. `db.to_vector()` renders the
list as pgvector's text format and every query casts explicitly.

---

## Frontend architecture

### Zoneless change detection

Angular 22 runs zoneless with OnPush by default. **All state is signals.**
Assigning a plain class field inside an HTTP callback updates the object and
never re-renders the view — silently, with no error. This is the single most
common Angular 22 mistake.

### State ownership

`DocumentStore` is the only source of truth. Every feature component injects it
rather than passing data through inputs and outputs.

```
documents        signal<DocumentSummary[]>
activeId         signal<string | null>
turns            signal<ChatTurn[]>
limits           signal<Limits>

active           computed  — the selected document
canAsk           computed  — active?.status === 'ready'
pageCoverage     computed  — which pages have been cited
relevanceTrend   computed  — mean relevance per answered turn
```

The charts are computed signals over `turns`, so they update automatically as
answers arrive. No chart-refresh logic exists anywhere.

### Session identity

A UUID generated by `crypto.randomUUID()` on first visit, kept in
`localStorage`, attached to every request by an HTTP interceptor. The
interceptor checks the URL prefix first — without that guard the session id
would ride along on every outbound request including third-party ones.

### Layout

The shell owns the viewport: `body` has `overflow: hidden`, the shell is
`100dvh`, and three columns each scroll internally. No column can stretch into
dead space because none is taller than the viewport.

| Width | Layout |
|---|---|
| ≥1321px | three columns: library · chat · insights |
| 981–1320px | two columns; insights under library |
| ≤980px | one pane at a time, tabs in the topbar |

Mobile tabs are driven by one signal, and the stylesheet force-shows all
regions above 980px — so the desktop layout never consults it and no JS media
query is needed.
