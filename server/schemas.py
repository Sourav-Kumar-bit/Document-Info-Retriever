from datetime import datetime

from pydantic import BaseModel, Field


class DocumentOut(BaseModel):
    id: str
    filename: str
    status: str                 # processing | ready | failed
    error: str | None = None
    page_count: int | None = None
    chunk_count: int | None = None
    created_at: datetime | None = None


class UploadAccepted(BaseModel):
    id: str
    status: str = "processing"


class QueryRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)


class SourceOut(BaseModel):
    chunk_index: int
    page: int | None = None
    preview: str


class QueryResponse(BaseModel):
    answer: str
    enough_info: bool
    sources: list[SourceOut]
