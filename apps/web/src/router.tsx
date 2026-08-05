import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './shell/AppShell';
import { LoginRoute } from './routes/LoginRoute';
import { RevenueRoute } from './routes/RevenueRoute';
import { ShiftsRoute } from './routes/ShiftsRoute';
import { ReviewRoute } from './routes/ReviewRoute';
import { RunsRoute } from './routes/RunsRoute';
import { MyShiftsRoute } from './routes/MyShiftsRoute';
import { MyPayRoute } from './routes/MyPayRoute';
import { SetupRoute } from './routes/SetupRoute';
import { ImportRoute } from './routes/ImportRoute';

/**
 * The route tree. Auth is enforced in `beforeLoad` against the router context rather than
 * inside each component, so a protected route can never render un-authenticated even for
 * one frame.
 *
 * Later tasks add their route components here; the guard shape does not change.
 *
 * Version note: the plan's original router.tsx used a bare `createRootRoute()` plus a cast
 * of `context` to a local `RouterContext` interface inside `beforeLoad`. The installed
 * `@tanstack/react-router` (1.170.x, `@tanstack/router-core` 1.171.x) has moved that typed
 * router-context wiring to `createRootRouteWithContext<TRouterContext>()()`, so this uses
 * that API instead of the cast — `context` in `beforeLoad`/`appRoute` is then genuinely
 * typed as `RouterContext`, not `unknown` cast to it.
 */
export interface RouterContext {
  isAuthenticated: () => boolean;
}

const rootRoute = createRootRouteWithContext<RouterContext>()();

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginRoute,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppShell,
  beforeLoad: ({ context }) => {
    if (!context.isAuthenticated()) {
      throw redirect({ to: '/login' });
    }
  },
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: function Home() {
    return <p>Choose a section from the navigation.</p>;
  },
});

const revenueRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/revenue',
  component: RevenueRoute,
});

const shiftsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/shifts',
  component: ShiftsRoute,
});

const reviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/review',
  component: ReviewRoute,
});

const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/runs',
  component: RunsRoute,
});

const importRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/import',
  component: ImportRoute,
});

const setupRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/setup',
  component: SetupRoute,
});

const myShiftsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/me/shifts',
  component: MyShiftsRoute,
});

const myPayRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/me/pay',
  component: MyPayRoute,
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    revenueRoute,
    shiftsRoute,
    reviewRoute,
    runsRoute,
    importRoute,
    setupRoute,
    myShiftsRoute,
    myPayRoute,
  ]),
]);

export function makeRouter(context: RouterContext) {
  return createRouter({ routeTree, context });
}
