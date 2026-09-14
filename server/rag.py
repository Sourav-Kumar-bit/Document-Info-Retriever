from __future__ import annotations

import io
import logging
import time

from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pydantic import BaseModel, Field
from pypdf import PdfReader
from pypdf.errors import PdfReadError

import db
from config import CHUNK_OVERLAP, CHUNK_SIZE, document_embeddings, llm, query_embeddings

log = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 10 * 1024 * 1024   # 10 MB
MIN_EXTRACTED_CHARS = 200             # below this, assume a scanned PDF


class UploadRejected(Exception):
    """A bad file, with a message that is safe to show the user."""


# ------------------------------------------------------------- validation
def validate_pdf(data: bytes, content_type: str | None) -> None:
    """
    Runs BEFORE the document row is created, so a rejected file leaves no trace.
    Every message here is something the user can act on.
    """
    if not data:
        raise UploadRejected("The file is empty.")

    if len(data) > MAX_UPLOAD_BYTES:
        mb = len(data) / 1024 / 1024
        raise UploadRejected(f"File is {mb:.1f} MB. The limit is 10 MB.")

    if not data.startswith(b"%PDF"):
        raise UploadRejected("This doesn't look like a PDF file.")

    if content_type and content_type != "application/pdf":
        raise UploadRejected(f"Expected a PDF, got {content_type}.")


def read_pdf(data: bytes) -> list[Document]:
    """
    Reads from bytes in memory — never touches disk. Deployed servers have an
    ephemeral filesystem, so anything written there disappears on restart.

    Pages are 1-based here. PyPDFLoader was 0-based, so page numbers are one
    higher than in your Phase 2 data.
    """
    try:
        reader = PdfReader(io.BytesIO(data))
    except PdfReadError as exc:
        raise UploadRejected(f"Could not read this PDF: {exc}") from exc

    if reader.is_encrypted:
        raise UploadRejected("This PDF is password-protected.")

    pages = []
    for i, page in enumerate(reader.pages):
        text = (page.extract_text() or "").strip()
        if text:
            pages.append(Document(page_content=text, metadata={"page": i + 1}))

    if not pages:
        raise UploadRejected("No pages with readable text were found.")
    return pages


# -------------------------------------------------------------- embedding
def embed_all(texts: list[str], batch_size: int = 50) -> list[list[float]]:
    """Batched with exponential backoff — the Gemini free tier rate-limits hard."""
    vectors: list[list[float]] = []
    for start in range(0, len(texts), batch_size):
        batch = texts[start:start + batch_size]
        for attempt in range(5):
            try:
                vectors.extend(document_embeddings.embed_documents(batch))
                break
            except Exception as exc:
                if attempt == 4:
                    raise
                wait = 2 ** attempt
                log.warning(
                    "embedding batch failed (%s); retrying in %ss", exc, wait)
                time.sleep(wait)
    return vectors


# -------------------------------------------------------------- ingestion
def ingest_bytes(document_id: str, data: bytes) -> None:
    """
    Runs in a background thread. Takes 30-60 seconds.

    It must NEVER raise — nobody is waiting to catch it. Every failure path
    writes status='failed' with a message, which is what the frontend polls for
    and shows the user.
    """
    conn = db.connect()
    try:
        pages = read_pdf(data)

        splitter = RecursiveCharacterTextSplitter(
            chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP
        )
        chunks = splitter.split_documents(pages)

        total_chars = sum(len(c.page_content.strip()) for c in chunks)
        if total_chars < MIN_EXTRACTED_CHARS:
            raise UploadRejected(
                "Almost no text could be extracted. This looks like a scanned "
                "document — only PDFs with a text layer are supported."
            )

        vectors = embed_all([c.page_content for c in chunks])

        rows = [
            (i, c.metadata.get("page"), c.page_content, vec)
            for i, (c, vec) in enumerate(zip(chunks, vectors))
        ]
        db.insert_chunks(conn, document_id, rows)
        db.mark_ready(conn, document_id, len(pages), len(chunks))
        log.info("ingested %s: %d pages, %d chunks",
                 document_id, len(pages), len(chunks))

    except UploadRejected as exc:
        db.mark_failed(conn, document_id, str(exc))
    except Exception as exc:
        log.exception("ingestion failed for %s", document_id)
        db.mark_failed(conn, document_id, f"Processing failed: {exc}")
    finally:
        conn.close()


# ------------------------------------------------------------- answering
class Answer(BaseModel):
    answer: str = Field(description="The answer in a few sentences.")
    sources: list[int] = Field(description="Numbers of context chunks used.")
    enough_info: bool = Field(
        description="False if the context is insufficient.")


PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You answer questions about a document using ONLY the numbered context "
     "given. Cite the chunk numbers you used. If the context doesn't contain "
     "the answer, set enough_info to false and don't guess."),
    ("human", "Context:\n{context}\n\nQuestion: {question}"),
])

_chain = PROMPT | llm.with_structured_output(Answer)


def format_context(results: list[dict]) -> str:
    return "\n\n".join(
        f"[{i}] (page {r['page']})\n{r['content']}"
        for i, r in enumerate(results)
    )


def answer_question(document_id: str, question: str, k: int = 5) -> dict:
    conn = db.connect()
    try:
        vector = query_embeddings.embed_query(question)
        results = db.search_chunks(conn, document_id, vector, k=k)
    finally:
        conn.close()

    if not results:
        return {"answer": "", "enough_info": False, "sources": []}

    result = _chain.invoke({
        "context": format_context(results),
        "question": question,
    })

    sources = [
        {
            "chunk_index": results[i]["chunk_index"],
            "page": results[i]["page"],
            "preview": " ".join(results[i]["content"].split())[:200],
            "distance": results[i]["distance"],
        }
        for i in result.sources
        if 0 <= i < len(results)
    ]

    return {
        "answer": result.answer,
        "enough_info": result.enough_info,
        "sources": sources,
    }
