import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';

/** Exported separately from the route so it can be tested without the router or Cognito. */
export function LoginForm({
  onSubmit,
  title = t.login.title,
  submitLabel = t.login.signIn,
  passwordLabel = t.login.password,
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
    <form className="panel login" onSubmit={submit}>
      <h1 className="login__title">{title}</h1>
      {/* Only shown on the forced-password-change step, where a user who typed the right temporary
          password is being asked for another one and needs telling why. The string existed and was
          never rendered. */}
      {!emailOnly ? <p className="login__hint">{t.login.newPasswordHint}</p> : null}
      {emailOnly ? (
        <Field
          label={t.login.email}
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
      {/* role=status: a rejected sign-in changes nothing else on screen, and this is the one screen
          a user cannot get past without being told what went wrong. */}
      {error ? <p className="form__error" role="status">{error}</p> : null}
      <Button type="submit" variant="primary" block disabled={busy}>
        {busy ? t.login.signingIn : submitLabel}
      </Button>
    </form>
  );
}

export function LoginRoute() {
  const { status, signIn, completeNewPassword } = useAuth();
  const navigate = useNavigate();

  /**
   * Leave /login once signed in.
   *
   * Nothing did this before: `signIn` updated auth state and the user stayed staring at the
   * login form, with no error, as though the password had been silently rejected. The redirect
   * lives in an effect rather than after `await signIn(...)` because the sign-in helper resolves
   * for BOTH outcomes — success and the newPasswordRequired challenge — so navigating on resolve
   * would skip the password-change step.
   */
  useEffect(() => {
    if (status === 'signed-in') void navigate({ to: '/', replace: true });
  }, [status, navigate]);

  if (status === 'new-password-required') {
    return (
      <div className="login-page">
        <LoginForm
          title={t.login.newPasswordTitle}
          submitLabel={t.login.setPassword}
          passwordLabel={t.login.newPassword}
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
