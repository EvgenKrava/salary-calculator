import '@testing-library/jest-dom/vitest';

/**
 * jsdom does not implement HTMLDialogElement's showModal/close (jsdom#3294), so any component
 * using a native <dialog> throws "el.showModal is not a function" under test.
 *
 * The Modal primitive deliberately uses the native element — it gives us focus trapping, Escape
 * handling, the top layer and inert background for free, all of which hand-rolled overlays get
 * subtly wrong. So the gap is polyfilled here rather than avoided in the component.
 *
 * This mirrors the real semantics closely enough to test with: `open` reflects state, and
 * `close()` fires the `close` event the component listens for to stay in step with the DOM.
 */
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, returnValue?: string) {
    this.open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event('close'));
  };
}
