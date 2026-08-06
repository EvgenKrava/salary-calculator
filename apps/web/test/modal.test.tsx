import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '../src/ui/Modal';
import { t } from '../src/lib/i18n';

/**
 * The Modal primitive.
 *
 * Built on the native <dialog> so the browser supplies focus trapping, Escape-to-close, the top
 * layer and inert background content. These tests pin the contract the component owns: that
 * React state and the DOM's own open/close never drift apart, which is how a hand-rolled overlay
 * ends up invisible-but-present and swallowing clicks.
 */
describe('Modal', () => {
  it('is absent from the accessibility tree until opened', () => {
    render(
      <Modal open={false} onClose={() => {}} title="Імпорт">
        <p>body</p>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('exposes its title as the dialog name', () => {
    render(
      <Modal open onClose={() => {}} title="Імпорт графіка">
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: 'Імпорт графіка' })).toBeInTheDocument();
  });

  it('closes via the close button', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal open onClose={onClose} title="Імпорт">
        <p>body</p>
      </Modal>,
    );
    await user.click(screen.getByRole('button', { name: t.common.close }));
    expect(onClose).toHaveBeenCalled();
  });

  it('reports a native close (Escape) back to React', () => {
    // The browser closes the dialog itself on Escape. Without forwarding that event, React would
    // still believe the modal is open and refuse to reopen it.
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Імпорт">
        <p>body</p>
      </Modal>,
    );
    screen.getByRole('dialog').dispatchEvent(new Event('close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders a footer only when given one', () => {
    const { rerender } = render(
      <Modal open onClose={() => {}} title="Імпорт">
        <p>body</p>
      </Modal>,
    );
    expect(screen.queryByText('дія')).not.toBeInTheDocument();
    rerender(
      <Modal open onClose={() => {}} title="Імпорт" footer={<span>дія</span>}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByText('дія')).toBeInTheDocument();
  });
});
