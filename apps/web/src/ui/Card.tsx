import type { ReactNode } from 'react';
import './card.css';

/**
 * A titled container.
 *
 * Every route was hand-rolling `<div className="panel" style={{ padding: 'var(--s4)' }}>` with
 * its own inline margins, so padding and spacing drifted screen to screen — the main reason the
 * app read as assembled rather than designed. One primitive fixes it everywhere.
 *
 * `tone` exists because a blocked salary run and a normal form are not the same kind of object:
 * the blocked one is a worklist the manager must act on, and it should look like it.
 */
export function Card({
  title,
  description,
  actions,
  footer,
  tone = 'default',
  flush = false,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls in the header row. */
  actions?: ReactNode;
  footer?: ReactNode;
  tone?: 'default' | 'stop' | 'warn' | 'ok';
  /** Drop body padding — for a card whose only child is a full-bleed table. */
  flush?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={`card card--${tone}`}>
      {title || actions || description ? (
        <header className="card__head">
          <div className="card__heading">
            {title ? <h2 className="card__title">{title}</h2> : null}
            {description ? <p className="card__desc">{description}</p> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children ? <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div> : null}
      {footer ? <footer className="card__foot">{footer}</footer> : null}
    </section>
  );
}
