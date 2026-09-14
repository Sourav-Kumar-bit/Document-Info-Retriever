import { Component, computed, inject } from '@angular/core';

import { DocumentStore } from '../../core/document-store';

interface Bar {
  page: number;
  count: number;
  height: number;
}

interface TopPage {
  page: number;
  count: number;
  share: number;
}

/**
 * Charts are hand-rolled SVG on purpose — no chart library.
 *
 * For three small visuals over data this shaped, a dependency would add
 * ~200KB and fight the token system the whole way. Inline SVG inherits the
 * theme variables for free, so both themes work with no extra code.
 */
@Component({
  selector: 'app-insights',
  templateUrl: './insights.html',
  styleUrl: './insights.scss',
})
export class Insights {
  protected readonly store = inject(DocumentStore);

  /**
   * Page coverage. Pages nothing has cited render as faint ghost bars, so the
   * GAPS are the information — they show which parts of the document your
   * questions haven't reached yet.
   */
  protected readonly bars = computed<Bar[]>(() => {
    const { counts, totalPages, max } = this.store.pageCoverage();
    if (!totalPages) return [];
    // Cap the column count so a 200-page PDF doesn't render as hairlines.
    const pages = Math.min(totalPages, 36);
    return Array.from({ length: pages }, (_, i) => {
      const page = i + 1;
      const count = counts.get(page) ?? 0;
      return { page, count, height: count === 0 ? 8 : 16 + (count / max) * 68 };
    });
  });

  protected readonly coveragePct = computed(() => {
    const { touched, totalPages } = this.store.pageCoverage();
    return totalPages ? Math.round((touched / totalPages) * 100) : 0;
  });

  /** The three pages your questions keep landing on. */
  protected readonly topPages = computed<TopPage[]>(() => {
    const { counts } = this.store.pageCoverage();
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (!total) return [];
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([page, count]) => ({
        page,
        count,
        share: Math.round((count / total) * 100),
      }));
  });

  protected readonly trendPath = computed(() => {
    const values = this.store.relevanceTrend();
    if (values.length < 2) return '';
    const w = 240;
    const h = 52;
    const step = w / (values.length - 1);
    return values
      .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / 100) * h).toFixed(1)}`)
      .join(' ');
  });

  protected readonly trendArea = computed(() => {
    const path = this.trendPath();
    if (!path) return '';
    const points = path.split(' ');
    const lastX = points[points.length - 1].split(',')[0];
    return `0,52 ${path} ${lastX},52`;
  });

  protected readonly avgRelevance = computed(() => {
    const values = this.store.relevanceTrend();
    if (!values.length) return null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  });

  /** Arc length for the coverage ring. Circumference of r=30 is ~188.5. */
  protected ringDash(pct: number): string {
    return `${(pct / 100) * 188.5} 188.5`;
  }
}
