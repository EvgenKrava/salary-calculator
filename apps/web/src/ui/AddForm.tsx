import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { t } from '../lib/i18n';
import './addForm.css';

/**
 * An "add one of these" form that stays collapsed behind its own button until asked for.
 *
 * Setup is a Form screen (docs/design/system.md § Page archetypes) an admin opens to *read* what
 * is configured far more often than to add to it — locations and levels are created once. Two
 * permanently-open add Cards below the tables meant the screen led with empty inputs for work
 * nobody was doing, and spent two amber submit buttons on them while the system allows about one
 * primary action per view.
 *
 * The trigger is REPLACED by the form rather than sitting above it, matching how the employees
 * table swaps its "Запросити" button for the invite form. That is also why there is no
 * `aria-expanded` here: the attribute describes a toggle that stays put, and this button does not
 * exist while the form it opened is on screen.
 *
 * Focus is managed in both directions, because a disclosure that only works with a mouse is a
 * hover-only affordance by another name: opening moves focus to the first field, and closing puts
 * it back on the trigger — otherwise the button vanishing under the cursor drops focus to <body>
 * and a keyboard user restarts from the top of the page.
 */
export function AddForm({
  label,
  submitLabel,
  busy = false,
  onSubmit,
  onCancel,
  children,
}: {
  /** Names the action in all three places it appears: the trigger, the Card title, the submit. */
  label: string;
  /** Defaults to `label`; pass the pending wording ("Додаємо…") while a write is in flight. */
  submitLabel?: string;
  busy?: boolean;
  /**
   * Runs the add. Resolving `true` is what collapses the form, so a REJECTED add stays open with
   * its reason on screen — closing on failure would read as a successful save.
   */
  onSubmit: () => Promise<boolean>;
  /**
   * Clear the fields and the submit-level error. Called on cancel, so a reopened form never
   * shows the values or the failure from an abandoned attempt.
   */
  onCancel: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** Set when the close should hand focus back, i.e. every close but the initial render. */
  const returning = useRef(false);

  useEffect(() => {
    if (open) {
      // The first field, whatever it happens to be — this component does not know the form's
      // shape, and hardcoding an id at each call site is how they drift apart.
      formRef.current?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea')?.focus();
    } else if (returning.current) {
      returning.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  function close() {
    returning.current = true;
    setOpen(false);
  }

  function cancel() {
    onCancel();
    close();
  }

  if (!open) {
    return (
      <div className="add-form">
        {/* Secondary, not primary: this only reveals the form. The amber stays on the submit
            inside it, which is the action that writes. */}
        <Button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
          {label}
        </Button>
      </div>
    );
  }

  return (
    <div className="add-form">
      <form
        ref={formRef}
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onSubmit()) close();
        }}
        // Escape abandons the form, as it does in a pay-matrix cell and on the schedule's location
        // popover. Scoped to the form rather than the window because focus is inside it by
        // construction, so a global listener would only add a way to close someone else's.
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
        }}
      >
        <Card title={label}>
          {children}
          {/* `block` on both: at 390px two side-by-side buttons are unreadably cramped, which is
              what the prop exists for — the actions row wraps and each takes its own line. */}
          <div className="add-form__actions">
            <Button type="submit" variant="primary" block disabled={busy}>
              {submitLabel ?? label}
            </Button>
            <Button type="button" variant="quiet" block onClick={cancel} disabled={busy}>
              {t.common.cancel}
            </Button>
          </div>
        </Card>
      </form>
    </div>
  );
}
