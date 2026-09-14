import { Directive, ElementRef, HostListener, inject, input } from '@angular/core';

/**
 * Writes --rx / --ry from pointer position so a glass card leans toward the
 * cursor. The .tilt class in styles.scss consumes them.
 *
 * Restraint note: the effect is capped at a few degrees. Large tilts read as a
 * gimmick; small ones read as the card having physical presence, which is the
 * whole point of putting glass on screen.
 */
@Directive({
  selector: '[appTilt]',
  host: { class: 'tilt' },
})
export class TiltDirective {
  /** Maximum lean in degrees. */
  readonly appTilt = input(6, { transform: (v: number | string) => Number(v) || 6 });

  private readonly el = inject(ElementRef<HTMLElement>);
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  @HostListener('pointermove', ['$event'])
  onMove(event: PointerEvent): void {
    if (this.reduced.matches || event.pointerType === 'touch') return;

    const node = this.el.nativeElement as HTMLElement;
    const rect = node.getBoundingClientRect();
    const max = this.appTilt();

    // -0.5 .. 0.5 from the centre of the element
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;

    node.style.setProperty('--ry', `${px * max * 2}deg`);
    node.style.setProperty('--rx', `${-py * max * 2}deg`);
  }

  @HostListener('pointerleave')
  onLeave(): void {
    const node = this.el.nativeElement as HTMLElement;
    node.style.setProperty('--rx', '0deg');
    node.style.setProperty('--ry', '0deg');
  }
}
