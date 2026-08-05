import { StrictMode } from 'react';
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
  if (status === 'loading') return <p className="mono" style={{ padding: 'var(--s6)' }}>loading…</p>;
  const router = makeRouter({ isAuthenticated: () => status === 'signed-in' });
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
