import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { config } from './config';

type Status = 'loading' | 'signed-out' | 'signed-in' | 'new-password-required';

interface AuthState {
  status: Status;
  sub: string | null;
  email: string | null;
  groups: string[];
  signIn: (email: string, password: string) => Promise<void>;
  completeNewPassword: (password: string) => Promise<void>;
  signOut: () => void;
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthState | null>(null);

const pool = new CognitoUserPool({
  UserPoolId: config.userPoolId,
  ClientId: config.clientId,
});

function readSession(session: CognitoUserSession) {
  const payload = session.getAccessToken().decodePayload() as {
    sub?: string;
    'cognito:groups'?: string[];
  };
  const idPayload = session.getIdToken().decodePayload() as { email?: string };
  return {
    sub: payload.sub ?? null,
    email: idPayload.email ?? null,
    // The API authorizes on this claim; the UI uses it only to choose what to show.
    groups: payload['cognito:groups'] ?? [],
  };
}

/**
 * SRP auth against Cognito directly, so login is a form inside our own design system
 * rather than a redirect to the hosted UI.
 *
 * `getToken()` calls `getSession()` on every request rather than caching the token —
 * the SDK refreshes an expired access token from the refresh token there, so a manager
 * mid-way through entering a month of revenue does not get logged out.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [identity, setIdentity] = useState<{ sub: string | null; email: string | null; groups: string[] }>({
    sub: null,
    email: null,
    groups: [],
  });
  const [pendingUser, setPendingUser] = useState<CognitoUser | null>(null);

  useEffect(() => {
    const user = pool.getCurrentUser();
    if (!user) {
      setStatus('signed-out');
      return;
    }
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session?.isValid()) {
        setStatus('signed-out');
        return;
      }
      setIdentity(readSession(session));
      setStatus('signed-in');
    });
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const user = new CognitoUser({ Username: email, Pool: pool });
    await new Promise<void>((resolve, reject) => {
      user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
        onSuccess: (session) => {
          setIdentity(readSession(session));
          setStatus('signed-in');
          resolve();
        },
        onFailure: (err) => reject(new Error(err.message ?? 'Sign-in failed')),
        // Admin-created users arrive with a temporary password.
        newPasswordRequired: () => {
          setPendingUser(user);
          setStatus('new-password-required');
          resolve();
        },
      });
    });
  }, []);

  const completeNewPassword = useCallback(
    async (password: string) => {
      const user = pendingUser;
      if (!user) throw new Error('No pending sign-in');
      await new Promise<void>((resolve, reject) => {
        user.completeNewPasswordChallenge(password, {}, {
          onSuccess: (session) => {
            setIdentity(readSession(session));
            setStatus('signed-in');
            setPendingUser(null);
            resolve();
          },
          onFailure: (err) => reject(new Error(err.message ?? 'Could not set the password')),
        });
      });
    },
    [pendingUser],
  );

  const signOut = useCallback(() => {
    pool.getCurrentUser()?.signOut();
    setIdentity({ sub: null, email: null, groups: [] });
    setStatus('signed-out');
  }, []);

  const getToken = useCallback(async () => {
    const user = pool.getCurrentUser();
    if (!user) return null;
    return new Promise<string | null>((resolve) => {
      user.getSession((err: Error | null, session: CognitoUserSession | null) => {
        resolve(err || !session?.isValid() ? null : session.getAccessToken().getJwtToken());
      });
    });
  }, []);

  const value = useMemo<AuthState>(
    () => ({ status, ...identity, signIn, completeNewPassword, signOut, getToken }),
    [status, identity, signIn, completeNewPassword, signOut, getToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function useRole() {
  const { groups } = useAuth();
  return {
    isAdmin: groups.includes('admin'),
    isManager: groups.includes('manager') || groups.includes('admin'),
    isEmployee: groups.includes('employee'),
  };
}
