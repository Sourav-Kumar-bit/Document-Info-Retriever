# API reference

Base URL: `https://document-info-retriever.onrender.com`
Interactive docs: `/docs` · Schema: `/openapi.json`

## Authentication

There is none. Every endpoint except `/health` and `/limits` requires an
`X-Session-Id` header — an arbitrary string that scopes documents to a caller.
The frontend generates a UUID on first visit and keeps it in `localStorage`.

```
X-Session-Id: 7b2e4f1a-9c88-4d2b-9a01-5f8e2c1b7d33
```

Missing header → `422`. Empty header → `400`.

This is not security. Anyone who guesses a session id can read those documents.

---

## `GET /health`

Liveness check. No auth, no database.

```json
{ "status": "ok" }
```

Use it to warm the container before a real request — on the free tier the first
call after 15 idle minutes takes ~50 seconds.

---

## `GET /limits`

Server-published thresholds, so the frontend does not hardcode them.

```json
{ "max_upload_mb": 20, "max_pages": 400, "max_documents": 5 }
```

---

## `POST /documents`

Upload a PDF. Returns immediately; indexing happens in the background.

**Request** — `multipart/form-data`

| Field | Type | Notes |
|---|---|---|
| `file` | binary | PDF only |

**`202 Accepted`**

```json
{ "id": "a3f19c88-4d2b-4e77-9a01-5f8e2c1b7d33", "status": "processing" }
```

202 rather than 200 because the work has not happened yet. Poll
`GET /documents/{id}` until status is `ready` or `failed`.

**Errors**

| Code | When |
|---|---|
| `422` | empty file · over the size limit · not a PDF · password-protected · over the page cap |
| `429` | session already has 5 documents |
| `400` / `422` | session header empty or missing |

Every `422` body carries an actionable message:

```json
{ "detail": "File is 24.3 MB. The limit is 20 MB." }
```

Validation runs **before** the database row is created, so a rejected file
leaves no trace.

---

## `GET /documents`

All documents for this session, newest first.

```json
[
  {
    "id": "a3f19c88-4d2b-4e77-9a01-5f8e2c1b7d33",
    "filename": "attention.pdf",
    "status": "ready",
    "error": null,
    "page_count": 15,
    "chunk_count": 49,
    "created_at": "2026-09-14T10:22:31.482Z"
  }
]
```

---

## `GET /documents/{id}`

Single document. This is the polling endpoint — the frontend calls it every
2 seconds while status is `processing`, giving up after 15 minutes.

Same shape as the list entry above.

| status | meaning |
|---|---|
| `processing` | ingestion running; `page_count` and `chunk_count` are null |
| `ready` | queryable |
| `failed` | `error` holds a human-readable reason |

**`404`** if the id does not exist **or** belongs to another session. Returning
404 rather than 403 avoids confirming that an id is real.

---

## `DELETE /documents/{id}`

`204 No Content` on success, `404` otherwise. Chunks are removed by the
`on delete cascade` on the foreign key.

---

## `POST /documents/{id}/query`

Ask a question.

**Request**

```json
{
  "question": "What problem does this document address?",
  "history": [
    { "question": "What is multi-head attention?", "answer": "It runs several..." }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `question` | string | 1–1000 characters |
| `history` | array | optional, max 20 entries; the client sends the last 3 answered turns |

`history` is what makes follow-ups work. Without it, "why does it help?" and
"say that more simply" get embedded literally and match nothing in the document.

**`200 OK`**

```json
{
  "answer": "The document addresses the sequential computation constraint...",
  "enough_info": true,
  "resolved_question": null,
  "sources": [
    {
      "chunk_index": 23,
      "page": 5,
      "preview": "Multi-head attention allows the model to jointly attend...",
      "distance": 0.312
    }
  ]
}
```

| Field | Notes |
|---|---|
| `answer` | empty string when `enough_info` is false |
| `enough_info` | **false is a normal outcome**, not an error — it means nothing retrieved was relevant |
| `resolved_question` | non-null only when the rewrite step changed the question; show it as "Searched for…" |
| `sources[].chunk_index` | the real chunk index in the database, not the position in the result list |
| `sources[].distance` | cosine distance, 0 = identical. `(1 - distance) * 100` gives a relevance percentage |

**Errors**

| Code | When |
|---|---|
| `404` | document missing or not yours |
| `409` | document still `processing`, or `failed` (body carries the original error) |
| `422` | question empty or over 1000 characters |
| `502` | Gemini or Postgres failed; body names the exception type |

---

## Status code conventions

| Code | Used for |
|---|---|
| `202` | upload accepted, work queued |
| `204` | delete succeeded |
| `404` | not found **or** not yours |
| `409` | valid request, wrong document state |
| `422` | request understood but content unacceptable |
| `429` | per-session document limit |
| `502` | an upstream service failed — not the caller's fault |

---

## CORS

Only origins listed in `ALLOWED_ORIGINS` are permitted. Requests from `/docs`
or curl are not subject to CORS, so an endpoint can work perfectly in testing
and fail in the browser. If the frontend cannot reach the API, check this first.
