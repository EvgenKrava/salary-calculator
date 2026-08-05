import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '../src/routes/LoginRoute';
import { t } from '../src/lib/i18n';

describe('login', () => {
  it('labels both fields visibly, not by placeholder', () => {
    render(<LoginForm onSubmit={vi.fn()} />);
    // A placeholder-as-label disappears exactly when the user checks what they typed.
    expect(screen.getByLabelText(t.login.email)).toBeInTheDocument();
    expect(screen.getByLabelText(t.login.password)).toBeInTheDocument();
  });

  it('submits the credentials', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<LoginForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(t.login.email), 'a@b.com');
    await userEvent.type(screen.getByLabelText(t.login.password), 'hunter22hunter');
    await userEvent.click(screen.getByRole('button', { name: t.login.signIn }));
    expect(onSubmit).toHaveBeenCalledWith('a@b.com', 'hunter22hunter');
  });

  it('shows the reason a sign-in failed', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('Incorrect username or password.');
    });
    render(<LoginForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(t.login.email), 'a@b.com');
    await userEvent.type(screen.getByLabelText(t.login.password), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: t.login.signIn }));
    expect(await screen.findByText(/incorrect username or password/i)).toBeInTheDocument();
  });

  it('disables submit while signing in so a slow network cannot double-submit', async () => {
    let release: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((r) => (release = r)));
    render(<LoginForm onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(t.login.email), 'a@b.com');
    await userEvent.type(screen.getByLabelText(t.login.password), 'pw');
    await userEvent.click(screen.getByRole('button', { name: t.login.signIn }));
    expect(screen.getByRole('button', { name: t.login.signingIn })).toBeDisabled();
    release();
  });
});
