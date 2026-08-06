import type { ReactNode } from 'react';
import './toolbar.css';

/**
 * Page header: title on the left, actions on the right, wrapping on narrow screens.
 *
 * Every route opened with `<h1 style={{ marginBottom: 'var(--s4)' }}>` and then put its actions
 * wherever they happened to land — the Import button on one screen, the month picker on
 * another. Giving the page a consistent header line is most of what makes a set of screens feel
 * like one application.
 */
export function Toolbar({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Actions: buttons, month pickers, links. */
  children?: ReactNode;
}) {
  return (
    <div className="toolbar">
      <div className="toolbar__heading">
        <h1 className="toolbar__title">{title}</h1>
        {description ? <p className="toolbar__desc">{description}</p> : null}
      </div>
      {children ? <div className="toolbar__actions">{children}</div> : null}
    </div>
  );
}
