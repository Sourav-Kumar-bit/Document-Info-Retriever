import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';

import { ApiService } from '../../core/api.service';
import { DocumentStore } from '../../core/document-store';
import { TiltDirective } from '../../shared/tilt.directive';

type Phase = 'idle' | 'uploading' | 'queued' | 'rejected';

const MAX_BYTES = 10 * 1024 * 1024;

@Component({
  selector: 'app-uploader',
  imports: [TiltDirective],
  templateUrl: './uploader.html',
  styleUrl: './uploader.scss',
})
export class Uploader {
  private readonly api = inject(ApiService);
  protected readonly store = inject(DocumentStore);

  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  protected readonly phase = signal<Phase>('idle');
  protected readonly percent = signal(0);
  protected readonly message = signal<string | null>(null);
  protected readonly dragging = signal(false);
  protected readonly fileName = signal<string | null>(null);

  /** Five sheets in the 3D stack. Index drives depth in CSS. */
  protected readonly sheets = [0, 1, 2, 3, 4];

  protected browse(): void {
    this.fileInput().nativeElement.click();
  }

  protected onPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.start(file);
    input.value = ''; // allows re-picking the same file after a failure
  }

  // --- drag and drop -------------------------------------------------------
  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) this.start(file);
  }

  // --- upload --------------------------------------------------------------
  private start(file: File): void {
    // Client-side checks first. Instant feedback beats a round trip, and the
    // backend re-validates anyway — never trust the client.
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      return this.reject('That is not a PDF. Only PDF files can be indexed.');
    }
    if (file.size > MAX_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      return this.reject(`That file is ${mb} MB. The limit is 10 MB.`);
    }
    if (file.size === 0) {
      return this.reject('That file is empty.');
    }

    this.fileName.set(file.name);
    this.phase.set('uploading');
    this.percent.set(0);
    this.message.set(null);

    this.api.uploadDocument(file).subscribe({
      next: (event) => {
        if (event.kind === 'progress') {
          this.percent.set(event.percent);
          return;
        }
        // 202 received. The file is on the server; indexing runs in background.
        this.phase.set('queued');
        this.store.upsert({
          id: event.document.id,
          filename: file.name,
          status: 'processing',
          error: null,
          page_count: null,
          chunk_count: null,
          created_at: new Date().toISOString(),
        });
        this.store.watch(event.document.id);
        setTimeout(() => this.resetSoon(), 2600);
      },
      error: (err: Error) => this.reject(err.message),
    });
  }

  private reject(reason: string): void {
    this.phase.set('rejected');
    this.message.set(reason);
    this.percent.set(0);
  }

  protected dismiss(): void {
    this.phase.set('idle');
    this.message.set(null);
    this.fileName.set(null);
  }

  private resetSoon(): void {
    if (this.phase() === 'queued') this.dismiss();
  }
}
