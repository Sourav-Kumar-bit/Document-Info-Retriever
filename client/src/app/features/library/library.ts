import { Component, inject, signal } from '@angular/core';

import { ApiService } from '../../core/api.service';
import { DocumentStore } from '../../core/document-store';
import { DocumentSummary } from '../../core/models';

@Component({
  selector: 'app-library',
  templateUrl: './library.html',
  styleUrl: './library.scss',
})
export class Library {
  private readonly api = inject(ApiService);
  protected readonly store = inject(DocumentStore);

  protected readonly deleting = signal<string | null>(null);

  protected select(doc: DocumentSummary): void {
    if (doc.status === 'ready') this.store.select(doc.id);
  }

  protected remove(event: Event, doc: DocumentSummary): void {
    event.stopPropagation(); // don't also select the row we're deleting
    this.deleting.set(doc.id);
    this.api.deleteDocument(doc.id).subscribe({
      next: () => {
        this.store.remove(doc.id);
        this.deleting.set(null);
      },
      error: () => this.deleting.set(null),
    });
  }

  protected reload(): void {
    this.store.loadLibrary();
  }

  /** Long filenames get truncated in the middle so the extension survives. */
  protected short(name: string): string {
    if (name.length <= 30) return name;
    return `${name.slice(0, 18)}…${name.slice(-9)}`;
  }
}
