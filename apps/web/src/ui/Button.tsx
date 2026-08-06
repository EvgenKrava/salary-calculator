import type { ButtonHTMLAttributes } from 'react';
import './button.css';

type Variant = 'primary' | 'secondary' | 'danger';

export function Button({
  variant = 'secondary',
  size,
  block = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  /**
   * `sm` for actions inside a dense table row, where the default 44px tap target would blow the
   * row height apart. Everywhere else the default stands, so touch targets are never shrunk by
   * accident.
   */
  size?: 'sm';
  /** Full width below 480px — side-by-side buttons at 360px are unreadably cramped. */
  block?: boolean;
}) {
  // `className` is merged rather than overwritten: it used to be clobbered, so a caller adding
  // a utility class silently lost every button style.
  const classes = ['btn', `btn--${variant}`];
  if (size) classes.push(`btn--${size}`);
  if (block) classes.push('btn--block');
  if (className) classes.push(className);
  return <button {...props} className={classes.join(' ')} />;
}
