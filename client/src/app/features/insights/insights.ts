import { Component, computed, inject } from '@angular/core';

import { DocumentStore } from '../../core/document-store';

interface Bar {
  page: number;
  count: number;
  height: number;
}

/**
 * Charts are hand-rolled SVG on purpose — no chart library.
 *
 * With three small visuals over data this shaped, a charting dependency would
 * add ~200KB to the bundle and fight the design tokens the whole way. SVG
 * inherits the theme variables for free.
 */
@Component({
  selector: 'app-insights',
  templateUrl: './insights.html',
  styleUrl: './insights.scss',
})
export class Insights {
  protected readonly store = inject(DocumentStore);

  /**
   * Page coverage: which pages your questions have actually reached.
   * Untouched pages render as ghost bars, so the gaps are the information —
   * it shows you the parts of the document you haven't interrogated.
   */
  protected readonly bars = computed<Bar[]>(() => {
    const { counts, totalPages, max } = this.store.pageCoverage();
    if (!totalPages) return [];

    // Cap at 40 columns so a 200-page PDF doesn't produce hairlines.
    const pages = Math.min(totalPages, 40);
    return Array.from({ length: pages }, (_, i) => {
      const page = i + 1;
      const count = counts.get(page) ?? 0;
      return { page, count, height: count === 0 ? 6 : 12 + (count / max) * 76 };
    });
  });

  protected readonly coveragePct = computed(() => {
    const { touched, totalPages } = this.store.pageCoverage();
    if (!totalPages) return 0;
    return Math.round((touched / totalPages) * 100);
  });

  /** Trend polyline points for the relevance sparkline. */
  protected readonly trendPath = computed(() => {
    const values = this.store.relevanceTrend();
    if (values.length < 2) return '';
    const w = 240;
    const h = 56;
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
    return `0,56 ${path} ${lastX},56`;
  });

  protected readonly avgRelevance = computed(() => {
    const values = this.store.relevanceTrend();
    if (!values.length) return null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  });

  /** Ring dash for the coverage donut. Circumference of r=34 is ~213.6. */
  protected ringDash(pct: number): string {
    return `${(pct / 100) * 213.6} 213.6`;
  }
}
