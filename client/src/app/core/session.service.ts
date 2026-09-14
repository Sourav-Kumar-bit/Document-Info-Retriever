import { Injectable } from '@angular/core';

/**
 * The browser's identity. Not auth — a stable random id so the backend can
 * scope documents to whoever uploaded them. Clearing it starts a clean slate.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly key = 'dir_session_id';
  private cached: string | null = null;

  get id(): string {
    if (this.cached) return this.cached;
    let value = localStorage.getItem(this.key);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(this.key, value);
    }
    this.cached = value;
    return value;
  }

  get shortId(): string {
    return this.id.slice(0, 8);
  }

  reset(): void {
    localStorage.removeItem(this.key);
    this.cached = null;
  }
}
