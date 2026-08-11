import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../lib/i18n';
import './popover.css';

/**
 * A menu anchored to a trigger, rendered in a portal so nothing can clip it.
 *
 * **Why a portal rather than `position: absolute` in the cell.** The schedule grid's table lives in
 * `.grid__wrap`, which needs `overflow-x: auto` for 31 columns — and an overflow container clips
 * absolutely-positioned descendants. Worse, CSS computes the *other* axis to `auto` as soon as one
 * axis is not `visible`, so the popover was cut off on the right at the last day column and at the
 * bottom on the last row: the location list for a cell near either edge was unreachable, and those
 * are ordinary cells (the end of the month is exactly when a schedule gets finished). Raising
 * `z-index` cannot fix clipping — the box is painted, then cropped by an ancestor — which is why
 * this moves out of the ancestor entirely.
 *
 * Being `position: fixed` in a portal also puts it above the sticky name column, the sticky day
 * header, the publish bar and the mobile nav without any of them having to know it exists.
 *
 * Dismissal is unchanged from the hand-rolled version it replaces: a transparent scrim sibling
 * catches any click outside (rather than a document listener, which can miss), and the caller keeps
 * owning Escape.
 */
export function AnchoredPopover({
  anchor,
  onDismiss,
  label,
  children,
}: {
  /** The trigger. Its rect positions the panel, and it is re-read on scroll and resize. */
  anchor: RefObject<HTMLElement>;
  onDismiss: () => void;
  label: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const trigger = anchor.current;
    const box = panel.current;
    if (!trigger || !box) return;

    const a = trigger.getBoundingClientRect();
    const p = box.getBoundingClientRect();
    const margin = 8;

    // Below the trigger by default; above it when there is no room below. Near the bottom of a long
    // grid "below" is off-screen, and a menu that opens off-screen is the bug this exists to fix.
    const roomBelow = window.innerHeight - a.bottom;
    const top = roomBelow >= p.height + margin || a.top < p.height + margin
      ? Math.min(a.bottom, window.innerHeight - p.height - margin)
      : a.top - p.height;

    // Left-aligned to the trigger, pulled back inside the viewport at the right edge — the last day
    // column sits within a menu's width of it.
    const left = Math.max(margin, Math.min(a.left, window.innerWidth - p.width - margin));

    setAt({ top: Math.max(margin, top), left });
  }, [anchor]);

  // Before paint, so the panel never shows at the wrong place first.
  useLayoutEffect(place, [place]);

  useEffect(() => {
    // `capture` so the grid's own horizontal scroll container fires too, not just the window —
    // the panel is anchored to a cell that moves when the month scrolls sideways.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [place]);

  return createPortal(
    <>
      <button type="button" className="popover__scrim" aria-label={t.common.close} onClick={onDismiss} />
      <div
        ref={panel}
        className="popover"
        role="group"
        aria-label={label}
        style={at ? { top: at.top, left: at.left } : { visibility: 'hidden' }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
