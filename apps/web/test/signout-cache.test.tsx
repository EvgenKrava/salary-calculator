import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Signing out must drop every cached response.
 *
 * The QueryClient is a module-scoped singleton and the query keys are not scoped by user
 * identity, so without an explicit clear the next person to sign in on the same device — these
 * are shared shop tablets — can be served the previous user's cached shifts, revenue, and pay.
 * The API still authorizes every request, so nothing new can be written this way; the leak is
 * what stays on screen.
 */

const signOutSpy = vi.fn();
vi.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: class {
    getCurrentUser() {
      return { signOut: signOutSpy, getSession: (cb: (e: Error | null, s: null) => void) => cb(new Error('none'), null) };
    }
  },
  CognitoUser: class {},
  AuthenticationDetails: class {},
}));

vi.mock('../src/lib/config', () => ({
  config: { userPoolId: 'pool', clientId: 'client', apiBaseUrl: 'http://localhost' },
}));

const { AuthProvider, useAuth } = await import('../src/lib/auth');

function Harness({ client }: { client: QueryClient }) {
  const { signOut } = useAuth();
  return <button onClick={() => signOut()}>sign out</button>;
}

beforeEach(() => signOutSpy.mockReset());

describe('signOut', () => {
  it('clears cached query data so the next user cannot see it', async () => {
    const client = new QueryClient();
    // Seed the cache the way a signed-in manager's screens would.
    client.setQueryData(['shifts', {}], [{ id: 's1', employeeId: 'e1' }]);
    client.setQueryData(['salary-runs'], [{ id: 'r1' }]);
    expect(client.getQueryData(['shifts', {}])).toBeDefined();

    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Harness client={client} />
        </AuthProvider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'sign out' }));

    expect(signOutSpy).toHaveBeenCalled();
    // Both must be gone — not just invalidated, which would still serve the stale data.
    expect(client.getQueryData(['shifts', {}])).toBeUndefined();
    expect(client.getQueryData(['salary-runs'])).toBeUndefined();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
