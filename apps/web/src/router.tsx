import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './shell/AppShell';
import { LoginRoute } from './routes/LoginRoute';
import { TodayRoute } from './routes/TodayRoute';
import { RevenueRoute } from './routes/RevenueRoute';
import { ShiftsRoute } from './routes/ShiftsRoute';
import { ScheduleRoute } from './routes/ScheduleRoute';
import { ScheduleGrid } from './routes/ScheduleGrid';
import { ReviewRoute } from './routes/ReviewRoute';
import { RunsRoute } from './routes/RunsRoute';
import { MyShiftsRoute } from './routes/MyShiftsRoute';
import { MyPayRoute } from './routes/MyPayRoute';
import { SetupRoute } from './routes/SetupRoute';
import { EmployeesRoute } from './routes/EmployeesRoute';
import { DaysOffRoute } from './routes/DaysOffRoute';

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

/**
 * Home is the "Today" worklist.
 *
 * It used to render `<p>Choose a section from the navigation.</p>` — the front door of a payroll
 * tool asking the manager to work out where to go. See docs/design/system.md § Structure.
 */
const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: TodayRoute,
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

const scheduleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/schedule',
  component: ScheduleRoute,
});

/**
 * Building the schedule, as distinct from reading it: `/schedule` is the read-only month calendar,
 * this is the people x days editor that writes drafts.
 */
const scheduleEditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/schedule/edit',
  component: ScheduleGrid,
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

const employeesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/employees',
  component: EmployeesRoute,
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

const myDaysOffRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/me/days-off',
  component: DaysOffRoute,
});

export const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    revenueRoute,
    shiftsRoute,
    scheduleRoute,
    scheduleEditRoute,
    reviewRoute,
    runsRoute,
    employeesRoute,
    setupRoute,
    myShiftsRoute,
    myPayRoute,
    myDaysOffRoute,
  ]),
]);

export function makeRouter(context: RouterContext) {
  return createRouter({ routeTree, context });
}
