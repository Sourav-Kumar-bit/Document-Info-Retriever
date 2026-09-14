import { Component, OnInit, inject } from '@angular/core';

import { DocumentStore } from './core/document-store';
import { SessionService } from './core/session.service';
import { ThemeService } from './core/theme.service';
import { Chat } from './features/chat/chat';
import { Insights } from './features/insights/insights';
import { Library } from './features/library/library';
import { Uploader } from './features/uploader/uploader';

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

  ngOnInit(): void {
    this.store.loadLibrary();
  }
}
