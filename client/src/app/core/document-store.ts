import { Injectable, computed, inject, signal } from '@angular/core';
import { Subscription, interval, switchMap } from 'rxjs';

import { ApiService } from './api.service';
import {
  ChatTurn,
  DocumentSummary,
  HistoryTurn,
  Limits,
  QueryResponse,
  relevanceOf,
} from './models';

const POLL_MS = 2000;
// A 400-page PDF is ~1600 chunks, which is several minutes of embedding calls
// with backoff on the free tier. The old 3-minute timeout would mark a
// perfectly healthy ingestion as failed while the server was still working.
const POLL_TIMEOUT_MS = 900_000; // 15 minutes

// How many previous turns to send. Matches HISTORY_TURNS on the server.
const HISTORY_DEPTH = 3;

/**
 * Single source of truth, shared by every feature component.
 *
 * All state is signals. Angular 22 is zoneless with OnPush by default, so a
 * plain field assigned inside an HTTP callback would update the object and
 * never re-render the view. Signals are how the template finds out.
 */
@Injectable({ providedIn: 'root' })
export class DocumentStore {
  private readonly api = inject(ApiService);

  // ------------------------------------------------------------- raw state
  readonly documents = signal<DocumentSummary[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly turns = signal<ChatTurn[]>([]);
  readonly loadingLibrary = signal(false);
  /** Server-published limits. Sensible defaults until /limits responds. */
  readonly limits = signal<Limits>({
    max_upload_mb: 50,
    max_pages: 400,
    max_documents: 5,
  });
  readonly libraryError = signal<string | null>(null);

  private pollers = new Map<string, Subscription>();

  // --------------------------------------------------------------- derived
  readonly active = computed(
    () => this.documents().find((d) => d.id === this.activeId()) ?? null,
  );

  readonly canAsk = computed(() => this.active()?.status === 'ready');

  readonly processingCount = computed(
    () => this.documents().filter((d) => d.status === 'processing').length,
  );

  /** Chunks and pages across the whole library — the two ring stats. */
  readonly totals = computed(() => {
    const ready = this.documents().filter((d) => d.status === 'ready');
    return {
      documents: ready.length,
      pages: ready.reduce((sum, d) => sum + (d.page_count ?? 0), 0),
      chunks: ready.reduce((sum, d) => sum + (d.chunk_count ?? 0), 0),
    };
  });

  /**
   * How many times each page has been cited in this session.
   * This is the page-coverage chart — it shows which parts of the document
   * your questions have actually reached, and which are still untouched.
   */
  readonly pageCoverage = computed(() => {
    const counts = new Map<number, number>();
    for (const turn of this.turns()) {
      for (const source of turn.response?.sources ?? []) {
        if (source.page == null) continue;
        counts.set(source.page, (counts.get(source.page) ?? 0) + 1);
      }
    }
    const totalPages = this.active()?.page_count ?? 0;
    const max = Math.max(1, ...counts.values());
    return { counts, totalPages, max, touched: counts.size };
  });

  /** Mean relevance per answered turn — the trend sparkline. */
  readonly relevanceTrend = computed(() =>
    this.turns()
      .filter((t) => t.response?.enough_info)
      .map((t) => {
        const scores = (t.response?.sources ?? [])
          .map(relevanceOf)
          .filter((v): v is number => v !== null);
        return scores.length
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : null;
      })
      .filter((v): v is number => v !== null),
  );

  readonly answeredCount = computed(
    () => this.turns().filter((t) => t.response?.enough_info).length,
  );

  readonly unansweredCount = computed(
    () => this.turns().filter((t) => t.response && !t.response.enough_info).length,
  );

  // ---------------------------------------------------------------- library
  loadLimits(): void {
    // Failure is non-fatal — the defaults above stand in.
    this.api.limits().subscribe({ next: (l) => this.limits.set(l), error: () => {} });
  }

  loadLibrary(): void {
    this.loadingLibrary.set(true);
    this.libraryError.set(null);

    this.api.listDocuments().subscribe({
      next: (docs) => {
        this.documents.set(docs);
        this.loadingLibrary.set(false);

        // Resume polling for anything still processing — covers a page refresh
        // in the middle of an upload.
        docs.filter((d) => d.status === 'processing').forEach((d) => this.watch(d.id));

        if (!this.activeId()) {
          const firstReady = docs.find((d) => d.status === 'ready');
          if (firstReady) this.select(firstReady.id);
        }
      },
      error: (err: Error) => {
        this.libraryError.set(err.message);
        this.loadingLibrary.set(false);
      },
    });
  }

  select(id: string): void {
    if (this.activeId() === id) return;
    this.activeId.set(id);
    this.turns.set([]); // chat history belongs to a document, not the session
  }

  upsert(doc: DocumentSummary): void {
    this.documents.update((list) => {
      const i = list.findIndex((d) => d.id === doc.id);
      if (i === -1) return [doc, ...list];
      const next = [...list];
      next[i] = doc;
      return next;
    });
  }

  remove(id: string): void {
    this.stopWatching(id);
    this.documents.update((list) => list.filter((d) => d.id !== id));
    if (this.activeId() === id) {
      this.activeId.set(null);
      this.turns.set([]);
      const nextReady = this.documents().find((d) => d.status === 'ready');
      if (nextReady) this.select(nextReady.id);
    }
  }

  /**
   * Poll a processing document until it resolves.
   *
   * The hard timeout matters: if ingestion dies in a way that never writes
   * 'failed', this would otherwise poll forever and the spinner would never
   * stop. Better to surface a timeout the user can act on.
   */
  watch(id: string): void {
    if (this.pollers.has(id)) return;
    const startedAt = Date.now();

    const sub = interval(POLL_MS)
      .pipe(switchMap(() => this.api.getDocument(id)))
      .subscribe({
        next: (doc) => {
          this.upsert(doc);
          if (doc.status !== 'processing') {
            this.stopWatching(id);
            if (doc.status === 'ready' && !this.activeId()) this.select(id);
          } else if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
            this.stopWatching(id);
            this.upsert({
              ...doc,
              status: 'failed',
              error: 'Processing timed out. Try uploading again.',
            });
          }
        },
        error: () => this.stopWatching(id), // 404 means it was deleted
      });

    this.pollers.set(id, sub);
  }

  private stopWatching(id: string): void {
    this.pollers.get(id)?.unsubscribe();
    this.pollers.delete(id);
  }

  // ------------------------------------------------------------------- chat
  /**
   * The last few answered turns, oldest first.
   *
   * Only turns that actually produced an answer are included — sending a
   * failed turn would have the rewriter resolving pronouns against an error
   * message.
   */
  private history(): HistoryTurn[] {
    return this.turns()
      .filter((t) => t.response?.enough_info && t.response.answer)
      .slice(-HISTORY_DEPTH)
      .map((t) => ({ question: t.question, answer: t.response!.answer }));
  }

  ask(question: string): void {
    const documentId = this.activeId();
    if (!documentId) return;

    const history = this.history();

    const turn: ChatTurn = {
      id: crypto.randomUUID(),
      question,
      response: null,
      error: null,
      pending: true,
      askedAt: Date.now(),
    };
    this.turns.update((list) => [...list, turn]);

    this.api.askQuestion(documentId, question, history).subscribe({
      next: (response: QueryResponse) => this.settle(turn.id, { response, pending: false }),
      error: (err: Error) => this.settle(turn.id, { error: err.message, pending: false }),
    });
  }

  retry(turnId: string): void {
    const turn = this.turns().find((t) => t.id === turnId);
    if (!turn) return;
    this.turns.update((list) => list.filter((t) => t.id !== turnId));
    this.ask(turn.question);
  }

  clearChat(): void {
    this.turns.set([]);
  }

  private settle(id: string, patch: Partial<ChatTurn>): void {
    this.turns.update((list) =>
      list.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }
}
