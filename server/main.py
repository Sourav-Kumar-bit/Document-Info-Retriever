"""
Run locally:  uvicorn main:app --reload
Then open:    http://localhost:8000/docs
"""

import logging

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import db
import rag
import schemas
from config import ALLOWED_ORIGINS, MAX_DOCS_PER_SESSION

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Document Info Retriever", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


def session_id(x_session_id: str = Header(alias="X-Session-Id")) -> str:
    """
    Every request must identify its session. Declaring it as a dependency means
    FastAPI returns 422 automatically when the header is missing, so no route
    has to check for it.
    """
    if not x_session_id.strip():
        raise HTTPException(400, "X-Session-Id header cannot be empty")
    return x_session_id.strip()


@app.get("/health")
def health():
    """Cheap liveness check. Hosting pings this; so does the frontend, to
    detect a cold start before making a real request."""
    return {"status": "ok"}


# ------------------------------------------------------------------ upload
@app.post("/documents", status_code=202, response_model=schemas.UploadAccepted)
async def upload_document(
    file: UploadFile,
    background: BackgroundTasks,
    session: str = Depends(session_id),
):
    """
    202 Accepted, not 200 OK — the work hasn't happened yet.

    Ingestion takes 30-60 seconds. Doing it inline would time out the browser,
    so this returns an id immediately and the frontend polls GET /documents/{id}
    until status flips to ready or failed.
    """
    data = await file.read()

    try:
        rag.validate_pdf(data, file.content_type)
    except rag.UploadRejected as exc:
        raise HTTPException(422, str(exc))

    with db.connect() as conn:
        if db.count_documents(conn, session) >= MAX_DOCS_PER_SESSION:
            raise HTTPException(
                429,
                f"Limit of {MAX_DOCS_PER_SESSION} documents reached. "
                "Delete one before uploading another.",
            )
        doc_id = db.create_document(
            conn, session, file.filename or "untitled.pdf")

    background.add_task(rag.ingest_bytes, doc_id, data)
    return schemas.UploadAccepted(id=doc_id)


# --------------------------------------------------------------- documents
@app.get("/documents", response_model=list[schemas.DocumentOut])
def list_documents(session: str = Depends(session_id)):
    with db.connect() as conn:
        return db.list_documents(conn, session)


@app.get("/documents/{document_id}", response_model=schemas.DocumentOut)
def get_document(document_id: str, session: str = Depends(session_id)):
    """What the frontend polls every 2 seconds while status is 'processing'."""
    with db.connect() as conn:
        doc = db.get_document(conn, document_id, session)
    if not doc:
        raise HTTPException(404, "Document not found")
    return doc


@app.delete("/documents/{document_id}", status_code=204)
def delete_document(document_id: str, session: str = Depends(session_id)):
    with db.connect() as conn:
        if not db.delete_document(conn, document_id, session):
            raise HTTPException(404, "Document not found")


# ------------------------------------------------------------------- query
@app.post("/documents/{document_id}/query", response_model=schemas.QueryResponse)
def query_document(
    document_id: str,
    body: schemas.QueryRequest,
    session: str = Depends(session_id),
):
    with db.connect() as conn:
        doc = db.get_document(conn, document_id, session)

    if not doc:
        raise HTTPException(404, "Document not found")

    if doc["status"] == "processing":
        raise HTTPException(409, "This document is still being processed.")
    if doc["status"] == "failed":
        raise HTTPException(
            409, doc["error"] or "This document failed to process.")

    try:
        return rag.answer_question(document_id, body.question.strip())
    except Exception as exc:
        logging.exception("query failed for document %s", document_id)
        raise HTTPException(502, f"Query failed: {type(exc).__name__}: {exc}")
