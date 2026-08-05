import { StrictMode, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { AuthProvider, useAuth } from './lib/auth';
import { makeRouter } from './router';
import './styles/base.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Payroll data must not be silently stale — a manager refreshing after an import
      // should see the import.
      staleTime: 10_000,
      retry: 1,
    },
  },
});

function Root() {
  const { status } = useAuth();

  /**
   * The router is created ONCE and the auth check reads through a ref.
   *
   * Calling `makeRouter(...)` in the render body rebuilt the router on every state change,
   * throwing away its navigation state — so even after the redirect was added, signing in
   * remounted a fresh router still sitting on /login. The ref keeps the guard reading current
   * auth without the router identity depending on it.
   */
  const signedIn = useRef(false);
  signedIn.current = status === 'signed-in';
  const router = useMemo(() => makeRouter({ isAuthenticated: () => signedIn.current }), []);

  if (status === 'loading') return <p className="mono" style={{ padding: 'var(--s6)' }}>loading…</p>;
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
