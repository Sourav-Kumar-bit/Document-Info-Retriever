import { Component, OnInit, inject, signal } from '@angular/core';

import { DocumentStore } from './core/document-store';
import { SessionService } from './core/session.service';
import { ThemeService } from './core/theme.service';
import { Chat } from './features/chat/chat';
import { Insights } from './features/insights/insights';
import { Library } from './features/library/library';
import { Uploader } from './features/uploader/uploader';

export type Pane = 'library' | 'chat' | 'insights';

@Component({
  selector: 'app-root',
  imports: [Uploader, Library, Chat, Insights],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  protected readonly theme = inject(ThemeService);
  protected readonly session = inject(SessionService);
  protected readonly store = inject(DocumentStore);

  /**
   * Which pane is visible on narrow screens.
   *
   * No JS media query here: above 980px the stylesheet force-shows all three
   * regions regardless of this value, so one signal drives mobile tabs without
   * the desktop layout ever consulting it.
   */
  protected readonly pane = signal<Pane>('chat');

  protected readonly panes: { id: Pane; label: string }[] = [
    { id: 'library', label: 'Library' },
    { id: 'chat', label: 'Ask' },
    { id: 'insights', label: 'Insights' },
  ];

  ngOnInit(): void {
    this.store.loadLimits();
    this.store.loadLibrary();
  }

  protected show(pane: Pane): void {
    this.pane.set(pane);
  }
}
