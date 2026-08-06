import { useEffect, useRef, type ReactNode } from 'react';
import { t } from '../lib/i18n';
import './modal.css';

/**
 * Modal dialog, built on the native `<dialog>` element.
 *
 * Native rather than a styled `<div>` because the browser then gives us, for free and correctly:
 * focus trapping, Escape-to-close, the top layer (so nothing can z-index above it), inert
 * background content, and the right ARIA semantics. Hand-rolled overlays get all of that subtly
 * wrong, and this one holds a multi-step import where losing focus mid-flow is a real cost.
 *
 * Wide by default: the import flow shows tables of parsed rows and anomaly lists, which a
 * narrow dialog would turn into a scroll tunnel.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // showModal()/close() rather than an `open` attribute: only the imperative call puts the
    // dialog in the top layer and makes the rest of the page inert.
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The browser fires `close` for Escape and for form-method=dialog, so routing both through
    // onClose keeps React state in step with the DOM rather than leaving a ghost-open modal.
    const onNativeClose = () => onClose();
    el.addEventListener('close', onNativeClose);
    return () => el.removeEventListener('close', onNativeClose);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="modal-title"
      // Click on the backdrop (the dialog element itself, outside the panel) closes.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal__panel">
        <header className="modal__head">
          <div>
            <h2 className="modal__title" id="modal-title">
              {title}
            </h2>
            {description ? <p className="modal__desc">{description}</p> : null}
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label={t.common.close}>
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
