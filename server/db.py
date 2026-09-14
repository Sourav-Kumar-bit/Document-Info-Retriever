import psycopg

from config import DB_CONFIG


def to_vector(values: list[float]) -> str:
    """
    Render a Python list in pgvector's text format: '[0.1,0.2,0.3]'.

    WHY THIS EXISTS: passing a plain list lets psycopg's built-in list adapter
    turn it into a Postgres `double precision[]`. Assignment to a vector column
    still works (Postgres applies an assignment cast), but the `<=>` operator is
    only defined for `vector <=> vector`, so operator resolution fails with:

        operator does not exist: vector <=> double precision[]

    A text literal plus an explicit ::vector cast in the SQL is unambiguous and
    doesn't depend on which psycopg adapters happen to be registered.

    %.9g keeps float32 precision without writing 17 digits per dimension —
    which matters when you're sending 768 of them.
    """
    return "[" + ",".join(f"{v:.9g}" for v in values) + "]"


def connect():
    """
    No register_vector() call. With explicit ::vector casts everywhere, the
    adapter isn't needed, and not depending on it removes a failure mode.
    """
    return psycopg.connect(**DB_CONFIG)


# ------------------------------------------------------------------ writes
def create_document(conn, session_id: str, filename: str) -> str:
    row = conn.execute(
        "insert into documents (session_id, filename) values (%s, %s) returning id",
        (session_id, filename),
    ).fetchone()
    conn.commit()
    return str(row[0])


def insert_chunks(conn, document_id: str, rows: list[tuple]) -> None:
    """rows: [(chunk_index, page, content, embedding), ...]"""
    conn.cursor().executemany(
        """insert into chunks (document_id, chunk_index, page, content, embedding)
           values (%s, %s, %s, %s, %s::vector)""",
        [
            (document_id, i, page, content, to_vector(emb))
            for i, page, content, emb in rows
        ],
    )
    conn.commit()


def mark_ready(conn, document_id: str, page_count: int, chunk_count: int) -> None:
    conn.execute(
        """update documents set status = 'ready', page_count = %s, chunk_count = %s
           where id = %s""",
        (page_count, chunk_count, document_id),
    )
    conn.commit()


def mark_failed(conn, document_id: str, error: str) -> None:
    conn.execute(
        "update documents set status = 'failed', error = %s where id = %s",
        (error[:1000], document_id),   # truncate: tracebacks can be huge
    )
    conn.commit()


def delete_document(conn, document_id: str, session_id: str) -> bool:
    """Chunks go too, via `on delete cascade` in the schema."""
    cur = conn.execute(
        "delete from documents where id = %s and session_id = %s",
        (document_id, session_id),
    )
    conn.commit()
    return cur.rowcount > 0


# ------------------------------------------------------------------- reads
def _document_row_to_dict(r) -> dict:
    return {
        "id": str(r[0]),
        "filename": r[1],
        "status": r[2],
        "error": r[3],
        "page_count": r[4],
        "chunk_count": r[5],
        "created_at": r[6],
    }


def list_documents(conn, session_id: str) -> list[dict]:
    rows = conn.execute(
        """select id, filename, status, error, page_count, chunk_count, created_at
           from documents where session_id = %s order by created_at desc""",
        (session_id,),
    ).fetchall()
    return [_document_row_to_dict(r) for r in rows]


def get_document(conn, document_id: str, session_id: str) -> dict | None:
    """
    Scoped by session_id on purpose. Someone else's document returns None, and
    the route turns that into a 404 — not a 403, because a 403 would confirm
    the id exists.
    """
    row = conn.execute(
        """select id, filename, status, error, page_count, chunk_count, created_at
           from documents where id = %s and session_id = %s""",
        (document_id, session_id),
    ).fetchone()
    return _document_row_to_dict(row) if row else None


def count_documents(conn, session_id: str) -> int:
    return conn.execute(
        "select count(*) from documents where session_id = %s", (session_id,)
    ).fetchone()[0]


def search_chunks(conn, document_id: str, query_vector: list[float], k: int = 5):
    """
    `<=>` is cosine distance. LOWER IS CLOSER.

    The ::vector cast on the parameter is the fix for the 502 you hit — without
    it Postgres sees a float array and can't resolve the operator.

    The `where document_id` clause is the per-document isolation that FAISS
    couldn't do.
    """
    rows = conn.execute(
        """select chunk_index, page, content, embedding <=> %s::vector as distance
           from chunks
           where document_id = %s
           order by distance
           limit %s""",
        (to_vector(query_vector), document_id, k),
    ).fetchall()
    return [
        {"chunk_index": r[0], "page": r[1],
            "content": r[2], "distance": float(r[3])}
        for r in rows
    ]
