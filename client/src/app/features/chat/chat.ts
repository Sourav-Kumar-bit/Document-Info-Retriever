import {
  AfterViewChecked,
  Component,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { DocumentStore } from '../../core/document-store';
import { AnswerSource, relevanceOf } from '../../core/models';

const SUGGESTIONS = [
  'What problem does this document address?',
  'Summarise the main contribution.',
  'What are the stated limitations?',
  'Which methods or datasets are used?',
];

@Component({
  selector: 'app-chat',
  imports: [FormsModule],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
})
export class Chat implements AfterViewChecked {
  protected readonly store = inject(DocumentStore);
  protected readonly suggestions = SUGGESTIONS;

  /** Shown in the landing hero, which now lives inside the chat stage. */
  protected readonly heroSteps = [
    { n: 1, title: 'Upload', body: 'A PDF with a real text layer.' },
    { n: 2, title: 'Index', body: 'Split into chunks, embedded, stored.' },
    { n: 3, title: 'Ask', body: 'Answers arrive with their page numbers.' },
  ];

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly draft = signal('');
  protected readonly openSource = signal<string | null>(null);

  private lastCount = 0;

  ngAfterViewChecked(): void {
    // Only scroll when a turn is actually added, not on every change detection.
    const count = this.store.turns().length;
    if (count !== this.lastCount) {
      this.lastCount = count;
      const node = this.scroller()?.nativeElement;
      if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    }
  }

  protected send(): void {
    const question = this.draft().trim();
    if (!question || !this.store.canAsk()) return;
    this.store.ask(question);
    this.draft.set('');
  }

  protected onKeydown(event: KeyboardEvent): void {
    // Enter sends, Shift+Enter makes a new line — the convention people expect.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  protected useSuggestion(text: string): void {
    this.draft.set(text);
    this.send();
  }

  protected toggleSource(key: string): void {
    this.openSource.update((current) => (current === key ? null : key));
  }

  protected relevance(source: AnswerSource): number | null {
    return relevanceOf(source);
  }

  /** Arc length for the relevance dial. Circumference of r=16 is ~100.5. */
  protected dash(value: number): string {
    return `${(value / 100) * 100.5} 100.5`;
  }

  protected verdict(value: number): string {
    if (value >= 65) return 'strong';
    if (value >= 40) return 'fair';
    return 'weak';
  }
}
