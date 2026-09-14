import { Injectable, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

/**
 * Theme lives on <html data-theme>, so every CSS variable re-resolves at once.
 * The initial value is set by an inline script in index.html before first
 * paint — otherwise you get a white flash on every reload.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly key = 'dir_theme';
  readonly theme = signal<Theme>(this.read());

  toggle(): void {
    this.set(this.theme() === 'dark' ? 'light' : 'dark');
  }

  set(next: Theme): void {
    this.theme.set(next);
    document.documentElement.dataset['theme'] = next;
    try {
      localStorage.setItem(this.key, next);
    } catch {
      /* private mode — the theme just won't persist */
    }
  }

  private read(): Theme {
    const attr = document.documentElement.dataset['theme'];
    if (attr === 'light' || attr === 'dark') return attr;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
}
