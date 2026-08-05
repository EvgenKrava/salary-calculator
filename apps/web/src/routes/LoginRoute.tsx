import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { useAuth } from '../lib/auth';

/** Exported separately from the route so it can be tested without the router or Cognito. */
export function LoginForm({
  onSubmit,
  title = 'Sign in',
  submitLabel = 'Sign in',
  passwordLabel = 'Password',
  emailOnly = true,
}: {
  onSubmit: (email: string, password: string) => Promise<void>;
  title?: string;
  submitLabel?: string;
  passwordLabel?: string;
  emailOnly?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit(email, password);
    } catch (err) {
      // Show Cognito's own message — "Incorrect username or password" is more useful than
      // a generic failure, and it distinguishes a typo from a locked account.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" style={{ padding: 'var(--s6)', maxWidth: 380 }} onSubmit={submit}>
      <h1 style={{ marginBottom: 'var(--s6)' }}>{title}</h1>
      {emailOnly ? (
        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      ) : null}
      <Field
        label={passwordLabel}
        name="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error ? (
        <p style={{ color: 'var(--stop)', fontSize: 'var(--text-xs)', margin: '0 0 var(--s4)' }}>
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? 'Signing in…' : submitLabel}
      </Button>
    </form>
  );
}

export function LoginRoute() {
  const { status, signIn, completeNewPassword } = useAuth();

  if (status === 'new-password-required') {
    return (
      <div className="login-page">
        <LoginForm
          title="Set a new password"
          submitLabel="Set password"
          passwordLabel="New password"
          emailOnly={false}
          onSubmit={(_e, password) => completeNewPassword(password)}
        />
      </div>
    );
  }

  return (
    <div className="login-page">
      <LoginForm onSubmit={signIn} />
    </div>
  );
}
