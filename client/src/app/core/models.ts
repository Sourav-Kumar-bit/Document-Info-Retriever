/**
 * Mirrors server/schemas.py. No automatic sync — when a Pydantic model changes,
 * change it here too.
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

export interface AnswerSource {
  chunk_index: number;
  page: number | null;
  preview: string;
  /** Cosine distance, 0 = identical. Null until the backend patch is deployed. */
  distance?: number | null;
}

export interface QueryResponse {
  answer: string;
  enough_info: boolean;
  sources: AnswerSource[];
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
