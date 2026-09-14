/**
 * Mirrors server/schemas.py. No automatic sync — when a Pydantic model
 * changes, change it here too.
 */

export type DocumentStatus = 'processing' | 'ready' | 'failed';

export interface DocumentSummary {
  id: string;
  filename: string;
  status: DocumentStatus;
  error: string | null;
  page_count: number | null;
  chunk_count: number | null;
  created_at: string | null;
}

export interface UploadAccepted {
  id: string;
  status: DocumentStatus;
}

/** One previous exchange, sent so the backend can resolve follow-ups. */
export interface HistoryTurn {
  question: string;
  answer: string;
}

export interface QueryRequest {
  question: string;
  history: HistoryTurn[];
}

export interface AnswerSource {
  chunk_index: number;
  page: number | null;
  preview: string;
  /** Cosine distance, 0 = identical. */
  distance?: number | null;
}

export interface QueryResponse {
  answer: string;
  enough_info: boolean;
  sources: AnswerSource[];
  /**
   * Set when the backend rewrote the question — e.g. you typed "why does it
   * help?" and it searched for "why does multi-head attention help?". Shown in
   * the UI so a resolved follow-up doesn't look like the model answered
   * something you never asked.
   */
  resolved_question?: string | null;
}

/** Server-published limits, so thresholds aren't hardcoded in two places. */
export interface Limits {
  max_upload_mb: number;
  max_pages: number;
  max_documents: number;
}

/** Local UI state — not from the backend. */
export interface ChatTurn {
  id: string;
  question: string;
  response: QueryResponse | null;
  error: string | null;
  pending: boolean;
  askedAt: number;
}

/** Cosine distance (0..2) to a 0..100 relevance figure for the meters. */
export function relevanceOf(source: AnswerSource): number | null {
  if (source.distance === null || source.distance === undefined) return null;
  return Math.max(0, Math.min(100, Math.round((1 - source.distance) * 100)));
}
