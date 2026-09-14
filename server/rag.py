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
from config import (
    CHUNK_OVERLAP,
    CHUNK_SIZE,
    EMBED_BATCH,
    HISTORY_ANSWER_CHARS,
    HISTORY_TURNS,
    MAX_PAGES,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_MB,
    document_embeddings,
    llm,
    query_embeddings,
    rewriter_llm,
)

log = logging.getLogger(__name__)

MIN_EXTRACTED_CHARS = 200   # below this, assume a scanned PDF


class UploadRejected(Exception):
    """A bad file, with a message that is safe to show the user."""


# ------------------------------------------------------------- validation
def validate_pdf(data: bytes, content_type: str | None) -> None:
    """Runs BEFORE the document row is created, so a rejected file leaves no trace."""
    if not data:
        raise UploadRejected("The file is empty.")

    if len(data) > MAX_UPLOAD_BYTES:
        mb = len(data) / 1024 / 1024
        raise UploadRejected(
            f"File is {mb:.1f} MB. The limit is {MAX_UPLOAD_MB} MB.")

    if not data.startswith(b"%PDF"):
        raise UploadRejected("This doesn't look like a PDF file.")

    if content_type and content_type != "application/pdf":
        raise UploadRejected(f"Expected a PDF, got {content_type}.")


def read_pdf(data: bytes) -> list[Document]:
    """
    Reads from bytes in memory — never touches disk, because deployed servers
    have an ephemeral filesystem. Pages are 1-based.
    """
    try:
        reader = PdfReader(io.BytesIO(data))
    except PdfReadError as exc:
        raise UploadRejected(f"Could not read this PDF: {exc}") from exc

    if reader.is_encrypted:
        raise UploadRejected("This PDF is password-protected.")

    if len(reader.pages) > MAX_PAGES:
        raise UploadRejected(
            f"This PDF has {len(reader.pages)} pages. The limit is {MAX_PAGES}. "
            "Split it into smaller documents and upload them separately."
        )

    pages = []
    for i, page in enumerate(reader.pages):
        text = (page.extract_text() or "").strip()
        if text:
            pages.append(Document(page_content=text, metadata={"page": i + 1}))

    if not pages:
        raise UploadRejected("No pages with readable text were found.")
    return pages


# -------------------------------------------------------------- embedding
def embed_all(texts: list[str], batch_size: int = EMBED_BATCH) -> list[list[float]]:
    """Batched with exponential backoff — the Gemini free tier rate-limits hard."""
    vectors: list[list[float]] = []
    total = len(texts)
    for start in range(0, total, batch_size):
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
        log.info("embedded %d/%d", min(start + batch_size, total), total)
    return vectors


# -------------------------------------------------------------- ingestion
def ingest_bytes(document_id: str, data: bytes) -> None:
    """
    Runs in a background thread. It must NEVER raise — nobody is waiting to
    catch it. Every failure path writes status='failed' with a message, which
    is what the frontend polls for and shows the user.
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

        log.info("ingesting %s: %d pages, %d chunks",
                 document_id, len(pages), len(chunks))
        vectors = embed_all([c.page_content for c in chunks])

        rows = [
            (i, c.metadata.get("page"), c.page_content, vec)
            for i, (c, vec) in enumerate(zip(chunks, vectors))
        ]
        db.insert_chunks(conn, document_id, rows)
        db.mark_ready(conn, document_id, len(pages), len(chunks))

    except UploadRejected as exc:
        db.mark_failed(conn, document_id, str(exc))
    except Exception as exc:
        log.exception("ingestion failed for %s", document_id)
        db.mark_failed(conn, document_id, f"Processing failed: {exc}")
    finally:
        conn.close()


class Rewrite(BaseModel):
    """
    What the user actually wants, split into two independent things.

    WHY THIS EXISTS: retrieval embeds the user's message and finds similar
    passages. That works for "what is multi-head attention?" and fails
    completely for "answer in simpler words with an example" — the second is an
    instruction about FORMAT, not a question about content. Embedding it finds
    nothing relevant, the answerer sees five random chunks, and correctly
    reports it can't answer.

    The same split fixes pronouns: "why does it help?" carries no searchable
    meaning until "it" is resolved.
    """

    standalone_question: str = Field(
        description=(
            "What the user wants to know, phrased so it makes sense with no "
            "conversation context. Resolve pronouns using the history. If the "
            "new message ONLY asks to change how a previous answer was written "
            "(shorter, simpler, with an example, as a list, in another tone), "
            "repeat the previous question unchanged."
        )
    )
    style: str | None = Field(
        default=None,
        description=(
            "Any instruction about HOW to answer: length, reading level, tone, "
            "format, whether to include an example. Null if the user gave none."
        ),
    )


REWRITE_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You prepare a user's message for a document search system. You never "
     "answer the question yourself and you never use outside knowledge.\n\n"
     "Split the new message into what the user wants to know and how they want "
     "it answered. A message can be purely a style request, in which case the "
     "question stays the same as the previous turn."),
    ("human", "Conversation so far:\n{history}\n\nNew message: {question}"),
])

_rewrite_chain = REWRITE_PROMPT | rewriter_llm.with_structured_output(Rewrite)


def _format_history(history: list[dict]) -> str:
    """Recent turns only, answers truncated. Keeps tokens and latency down."""
    recent = history[-HISTORY_TURNS:]
    return "\n".join(
        f"Q: {t.get('question', '')}\nA: {(t.get('answer') or '')[:HISTORY_ANSWER_CHARS]}"
        for t in recent
    )


def rewrite(question: str, history: list[dict]) -> Rewrite:
    """
    Skipped entirely on the first question of a conversation — there is nothing
    to resolve and no reason to pay for an extra call.

    Failures fall back to the raw question. A rewrite problem should degrade to
    the old behaviour, never break the request.
    """
    if not history:
        return Rewrite(standalone_question=question, style=None)

    try:
        result = _rewrite_chain.invoke({
            "history": _format_history(history),
            "question": question,
        })
        if not result.standalone_question.strip():
            return Rewrite(standalone_question=question, style=None)
        return result
    except Exception as exc:
        log.warning("rewrite failed (%s); using the raw question", exc)
        return Rewrite(standalone_question=question, style=None)


# ------------------------------------------------------------- answering
class Answer(BaseModel):
    answer: str = Field(
        description="The answer, following any style instruction given.")
    sources: list[int] = Field(description="Numbers of context chunks used.")
    enough_info: bool = Field(
        description="False if the context is insufficient.")


PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "You answer questions about a document using ONLY the numbered context "
     "given. Cite the chunk numbers you used. If the context doesn't contain "
     "the answer, set enough_info to false and don't guess.\n\n"
     "If the user asked for a particular style — shorter, simpler, an example, "
     "a list — follow it, but never invent facts to satisfy it. An example must "
     "illustrate something the context actually says."),
    ("human",
     "Context:\n{context}\n\nQuestion: {question}\n\nHow to answer: {style}"),
])

_chain = PROMPT | llm.with_structured_output(Answer)


def format_context(results: list[dict]) -> str:
    return "\n\n".join(
        f"[{i}] (page {r['page']})\n{r['content']}"
        for i, r in enumerate(results)
    )


def answer_question(
    document_id: str,
    question: str,
    history: list[dict] | None = None,
    k: int = 5,
) -> dict:
    plan = rewrite(question, history or [])

    conn = db.connect()
    try:
        # Retrieval runs on the REWRITTEN question, which is the whole point.
        vector = query_embeddings.embed_query(plan.standalone_question)
        results = db.search_chunks(conn, document_id, vector, k=k)
    finally:
        conn.close()

    if not results:
        return {
            "answer": "",
            "enough_info": False,
            "sources": [],
            "resolved_question": plan.standalone_question,
        }

    result = _chain.invoke({
        "context": format_context(results),
        "question": plan.standalone_question,
        "style": plan.style or "Plain prose, a few sentences.",
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
        "resolved_question": (
            plan.standalone_question
            if plan.standalone_question.strip().lower() != question.strip().lower()
            else None
        ),
    }
