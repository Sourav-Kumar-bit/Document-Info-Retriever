import {
  HttpClient,
  HttpErrorResponse,
  HttpEvent,
  HttpEventType,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, filter, map, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { environment } from '../../environments/environment';
import {
  DocumentSummary,
  HistoryTurn,
  Limits,
  QueryResponse,
  UploadAccepted,
} from './models';

export type UploadEvent =
  | { kind: 'progress'; percent: number }
  | { kind: 'done'; document: UploadAccepted };

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;

  health(): Observable<{ status: string }> {
    return this.http
      .get<{ status: string }>(`${this.base}/health`)
      .pipe(catchError(toFriendlyError));
  }

  /** Upload thresholds, published by the server so they live in one place. */
  limits(): Observable<Limits> {
    return this.http
      .get<Limits>(`${this.base}/limits`)
      .pipe(catchError(toFriendlyError));
  }

  listDocuments(): Observable<DocumentSummary[]> {
    return this.http
      .get<DocumentSummary[]>(`${this.base}/documents`)
      .pipe(catchError(toFriendlyError));
  }

  getDocument(id: string): Observable<DocumentSummary> {
    return this.http
      .get<DocumentSummary>(`${this.base}/documents/${id}`)
      .pipe(catchError(toFriendlyError));
  }

  deleteDocument(id: string): Observable<void> {
    return this.http
      .delete<void>(`${this.base}/documents/${id}`)
      .pipe(catchError(toFriendlyError));
  }

  /**
   * reportProgress + observe:'events' turns one request into a stream.
   *
   * Note there is no Content-Type header anywhere here. The browser must set it
   * itself for multipart, because it has to embed the boundary marker — set it
   * by hand and the upload silently breaks.
   */
  uploadDocument(file: File): Observable<UploadEvent> {
    const form = new FormData();
    form.append('file', file, file.name);

    return this.http
      .post<UploadAccepted>(`${this.base}/documents`, form, {
        reportProgress: true,
        observe: 'events',
      })
      .pipe(
        map((event: HttpEvent<UploadAccepted>): UploadEvent | null => {
          if (event.type === HttpEventType.UploadProgress) {
            const percent = event.total
              ? Math.round((100 * event.loaded) / event.total)
              : 0;
            return { kind: 'progress', percent };
          }
          if (event.type === HttpEventType.Response && event.body) {
            return { kind: 'done', document: event.body };
          }
          return null;
        }),
        filter((e): e is UploadEvent => e !== null),
        catchError(toFriendlyError),
      );
  }

  /**
   * History lets the backend resolve follow-ups ("why does it help?") and
   * style requests ("say that more simply"). Without it, those messages get
   * embedded literally and match nothing in the document.
   */
  askQuestion(
    documentId: string,
    question: string,
    history: HistoryTurn[] = [],
  ): Observable<QueryResponse> {
    return this.http
      .post<QueryResponse>(`${this.base}/documents/${documentId}/query`, {
        question,
        history,
      })
      .pipe(catchError(toFriendlyError));
  }
}

/**
 * HttpErrorResponse to a message a person can act on.
 *
 * status 0 means the request never reached the server. On Render's free tier
 * that's almost always a cold start rather than an outage, so it gets wording
 * that tells the user to wait rather than wording that says something broke.
 */
function toFriendlyError(err: HttpErrorResponse) {
  let message: string;

  if (err.status === 0) {
    message = 'Server is waking up. This takes up to a minute on the free tier.';
  } else if (typeof err.error?.detail === 'string') {
    message = err.error.detail;
  } else if (Array.isArray(err.error?.detail)) {
    message = err.error.detail.map((d: { msg?: string }) => d.msg).join('; ');
  } else if (err.status === 404) {
    message = 'That document no longer exists.';
  } else if (err.status === 413) {
    message = 'That file is too large for the server to accept.';
  } else {
    message = `Request failed (HTTP ${err.status}).`;
  }

  return throwError(() => new Error(message));
}
