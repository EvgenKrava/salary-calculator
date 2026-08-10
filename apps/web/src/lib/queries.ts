import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { createApiClient, type ApiClient } from './api';
import { config } from './config';
import { useAuth } from './auth';

export interface Location {
  id: string;
  name: string;
  opensAt: string;
  closesAt: string;
}
export interface Level {
  id: string;
  name: string;
}
export interface Employee {
  id: string;
  name: string;
  levelId: string;
  cognitoSub: string | null;
  active: boolean;
}
export interface RevenueRow {
  id: string;
  locationId: string;
  revenueDate: string;
  amount: number;
  source: string;
  status: string;
}
export interface Shift {
  id: string;
  employeeId: string;
  locationId: string;
  workDate: string;
  startsAt: string;
  endsAt: string;
  status: string;
  source: string;
}
export interface SalaryRunLine {
  employeeId: string;
  hourlyPay: number;
  revenueShare: number;
  bonus: number;
  total: number;
}
export interface SalaryRun {
  id: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  lines?: SalaryRunLine[];
}
export interface ExtractionJob {
  id: string;
  docType: string;
  s3Key: string;
  status: string;
  confidence: number | null;
  extracted: unknown;
  reviewedBy: string | null;
}

export function useApi(): ApiClient {
  const { getToken } = useAuth();
  return useMemo(
    () => createApiClient({ baseUrl: config.apiUrl, getToken }),
    [getToken],
  );
}

export function useLocations() {
  const api = useApi();
  return useQuery({ queryKey: ['locations'], queryFn: () => api.get<Location[]>('/api/locations') });
}

export function useAddLocation() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; opensAt: string; closesAt: string }) =>
      api.post<Location>('/api/locations', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

/**
 * Edit a location's name or working hours.
 *
 * The hours are not cosmetic: a day rate is **pro-rated against the location's working day**
 * (see calculateSalaries), so `opensAt`/`closesAt` are a payroll input. The deployed locations
 * still carry placeholder 09:00–21:00 hours precisely because there was no way to change them
 * without hand-writing an API call.
 */
export function useUpdateLocation() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      opensAt?: string;
      closesAt?: string;
    }) => api.patch<Location>(`/api/locations/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['locations'] });
      // Changing the working day changes every future run's proration denominator.
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}

/**
 * Delete a location.
 *
 * Expected to fail with 409 once the location has revenue, shifts or slot windows — those are
 * payroll history and the FK is deliberate. Callers surface the API's message rather than
 * pre-checking, because the API is the only place that knows.
 */
export function useDeleteLocation() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: string }>(`/api/locations/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

export function useLevels() {
  const api = useApi();
  return useQuery({ queryKey: ['levels'], queryFn: () => api.get<Level[]>('/api/levels') });
}

export function useAddLevel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string }) => api.post<Level>('/api/levels', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['levels'] }),
  });
}

/** Edit a level's name. Pay now lives on the (level, location) matrix, not here. */
export function useUpdateLevel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string }) =>
      api.patch<Level>(`/api/levels/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['levels'] });
      // Employees render their level's rate, and a run recomputes from it.
      void qc.invalidateQueries({ queryKey: ['employees'] });
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}

/** Delete a level. 409 while any employee still references it. */
export function useDeleteLevel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: string }>(`/api/levels/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['levels'] }),
  });
}

export interface PayRateDto {
  levelId: string;
  locationId: string;
  ratePerDay: number;
  revenuePercent: number;
}

/** The (level, location) pay matrix — every configured cell. */
export function usePayRates() {
  const api = useApi();
  return useQuery({ queryKey: ['pay-rates'], queryFn: () => api.get<PayRateDto[]>('/api/pay-rates') });
}

/** Upsert one matrix cell. The body is the full cell state, not a patch. */
export function useSetPayRate() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { levelId: string; locationId: string; ratePerDay: number; revenuePercent?: number }) =>
      api.put<PayRateDto>('/api/pay-rates', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pay-rates'] });
      // The matrix is a payroll input: a changed cell changes what a future run pays.
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}

export function useClearPayRate() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ levelId, locationId }: { levelId: string; locationId: string }) =>
      api.del<{ deleted: boolean }>(`/api/pay-rates?levelId=${levelId}&locationId=${locationId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pay-rates'] });
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}

export interface NameMapping {
  sourceName: string;
  employeeId: string | null;
  ignored: boolean;
}

/**
 * The persisted spreadsheet-name -> employee mapping.
 *
 * The importer deliberately never guesses who gets paid, so every distinct name row in the
 * workbook must be mapped once (or marked ignored, for placeholders like "Бариста 1"). Until
 * then a parsed cell cannot become a shift — the real workbook parses 3,337 cells and resolves
 * none of them without this.
 */
export function useNameMap() {
  const api = useApi();
  return useQuery({ queryKey: ['schedule-name-map'], queryFn: () => api.get<NameMapping[]>('/api/schedule-name-map') });
}

export function useSetNameMapping() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { sourceName: string; employeeId?: string | null; ignored?: boolean }) =>
      api.put<NameMapping>('/api/schedule-name-map', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['schedule-name-map'] }),
  });
}

export function useEmployees() {
  const api = useApi();
  return useQuery({ queryKey: ['employees'], queryFn: () => api.get<Employee[]>('/api/employees') });
}

export function useAddEmployee() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      levelId: string;
      cognitoSub?: string | null;
      active?: boolean;
    }) => api.post<Employee>('/api/employees', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}

export function useInviteEmployee() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; email: string; role: 'admin' | 'manager' | 'employee' }) =>
      api.post<Employee & { email: string }>(`/api/employees/${id}/invite`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}

export function useUpdateEmployee() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      levelId?: string;
      cognitoSub?: string | null;
      active?: boolean;
    }) => api.patch<Employee>(`/api/employees/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}

export function useRevenue(params: { from?: string; to?: string } = {}) {
  const api = useApi();
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['revenue', params.from ?? null, params.to ?? null],
    queryFn: () => api.get<RevenueRow[]>(`/api/revenue${suffix}`),
  });
}

export function useAddRevenue() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { locationId: string; revenueDate: string; amount: number }) =>
      api.post<RevenueRow>('/api/revenue', body),
    // A salary run reads revenue, so both views must reflect a new day.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['revenue'] });
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}

export function useShifts(params: { status?: string; from?: string; to?: string } = {}) {
  const api = useApi();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['shifts', params],
    queryFn: () => api.get<Shift[]>(`/api/shifts${suffix}`),
  });
}

export function useShiftDecision() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
      api.post<Shift>(`/api/shifts/${id}/${decision}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}

/**
 * Assign a shift by hand.
 *
 * The endpoint existed from the start; nothing in the UI called it, so the schedule was
 * read-only and the only way in was a workbook import. That leaves real gaps: the import
 * reports 148 *substitutions* (a covering person's name written where a location number
 * belongs) which it deliberately refuses to guess at, so those shifts exist on paper and
 * nowhere in the app — nobody is paid for them until someone enters them.
 *
 * `startsAt`/`endsAt` are optional: omitted, the API falls back to the location's own opening
 * hours, which is the right default for a single-slot day.
 *
 * `status` is optional and defaults to `approved` on the server, so existing callers are
 * unchanged. The schedule grid passes `draft` — a month being built, invisible to staff and
 * uncounted by payroll until it is published.
 */
export function useAssignShift() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      employeeId: string;
      locationId: string;
      workDate: string;
      startsAt?: string;
      endsAt?: string;
      status?: 'draft' | 'requested' | 'approved';
    }) => api.post<Shift>('/api/shifts', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      // A salary run reads approved shifts, so a hand-entered shift changes what a run owes.
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}

export function useDeleteShift() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ deleted: string }>(`/api/shifts/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}

export interface ShiftSlot {
  locationId: string;
  slotNumber: number;
  startsAt: string;
  endsAt: string;
}

/**
 * A location's shift-slot windows.
 *
 * These are what the schedule importer maps a slot column onto, and — more importantly — the
 * denominator for revenue-share proration. There was no UI for them at all, which is why the
 * deployed locations still carry placeholder hours: a wrong window silently pays the wrong
 * amount, because a day rate is pro-rated against the location's working day.
 */
export function useShiftSlots(locationId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ['shift-slots', locationId ?? null],
    queryFn: () => api.get<ShiftSlot[]>(`/api/locations/${locationId}/slots`),
    // No location chosen yet means there is nothing to fetch.
    enabled: Boolean(locationId),
  });
}

/**
 * Slot windows for several locations at once, keyed by `locationId`.
 *
 * The schedule grid needs every location's own windows, not one location's applied to all of them:
 * `location_shift_slots` is keyed `(location_id, slot_number)` and each café has its own opening
 * hours, so slot 1 is 08:00–14:00 at one and 09:00–15:00 at another. Reading only the first
 * location's windows and writing them for every cell records the wrong hours — and hours are pay,
 * since a day rate prorates against the working day.
 *
 * One request per location. The chain has a handful of locations, so the alternative (a batch
 * endpoint) would be new API surface for no measurable gain.
 */
export function useShiftSlotsByLocation(locationIds: string[]) {
  const api = useApi();
  return useQueries({
    queries: locationIds.map((id) => ({
      queryKey: ['shift-slots', id],
      queryFn: () => api.get<ShiftSlot[]>(`/api/locations/${id}/slots`),
    })),
    // `combine` rather than a useMemo over the results array: the array is a fresh object every
    // render, so memoising it correctly means depending on derived strings, which is easy to get
    // subtly wrong. React Query owns the memoisation here.
    combine: (results) => {
      const byLocation = new Map<string, ShiftSlot[]>();
      locationIds.forEach((id, i) => {
        const data = results[i]?.data;
        if (data) byLocation.set(id, data);
      });
      return {
        byLocation,
        /** Every distinct slot number across all locations — the grid's tabs. */
        slotNumbers: [...new Set([...byLocation.values()].flat().map((s) => s.slotNumber))].sort(
          (a, b) => a - b,
        ),
        isLoading: results.some((r) => r.isLoading),
        error: (results.find((r) => r.error)?.error ?? null) as Error | null,
      };
    },
  });
}

export function useSetShiftSlot() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      locationId,
      slotNumber,
      ...body
    }: {
      locationId: string;
      slotNumber: number;
      startsAt: string;
      endsAt: string;
    }) => api.put<ShiftSlot>(`/api/locations/${locationId}/slots/${slotNumber}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shift-slots'] });
      // Slot windows decide the hours an imported shift gets, so a future import differs.
      void qc.invalidateQueries({ queryKey: ['shifts'] });
    },
  });
}

export function useDeleteShiftSlot() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ locationId, slotNumber }: { locationId: string; slotNumber: number }) =>
      api.del<{ deleted: number }>(`/api/locations/${locationId}/slots/${slotNumber}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shift-slots'] });
    },
  });
}

export function useExtractionJobs(status?: string) {
  const api = useApi();
  const suffix = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['extraction-jobs', status ?? null],
    queryFn: () => api.get<ExtractionJob[]>(`/api/extraction-jobs${suffix}`),
  });
}

export function useJobDecision() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, reason }: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      api.post<ExtractionJob>(
        `/api/extraction-jobs/${id}/${decision}`,
        decision === 'reject' ? { reason: reason ?? 'rejected by reviewer' } : undefined,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['extraction-jobs'] }),
  });
}

export function useSalaryRuns() {
  const api = useApi();
  return useQuery({ queryKey: ['salary-runs'], queryFn: () => api.get<SalaryRun[]>('/api/salary-runs') });
}

/**
 * Dry-run a salary period: the exact figures a commit would write, persisted nowhere.
 *
 * A run is final and immediately visible to employees, so committing blind was the app's
 * sharpest edge — a mistyped bonus or a missing revenue day could not be undone. This shares
 * one server code path with the commit, so the previewed number IS the number paid.
 */
export function useSalaryRunPreview() {
  const api = useApi();
  return useMutation({
    mutationFn: (body: { year: number; month: number; half: 1 | 2; bonuses?: Record<string, number> }) =>
      api.post<{
        periodStart: string;
        periodEnd: string;
        lines: SalaryRunLine[];
        gaps: { employeeId: string; locationId: string; date: string }[];
        missingRates: { levelId: string; locationId: string }[];
        blocked: boolean;
      }>('/api/salary-runs/preview', body),
  });
}

export function useCreateSalaryRun() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { year: number; month: number; half: 1 | 2; bonuses?: Record<string, number> }) =>
      api.post<SalaryRun & { lines: SalaryRunLine[] }>('/api/salary-runs', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['salary-runs'] }),
  });
}

export function useMyShifts() {
  const api = useApi();
  return useQuery({ queryKey: ['my-shifts'], queryFn: () => api.get<Shift[]>('/api/shifts/me') });
}

export function useMyPay() {
  const api = useApi();
  return useQuery({
    queryKey: ['my-pay'],
    queryFn: () =>
      api.get<
        { runId: string; periodStart: string; periodEnd: string; hourlyPay: number; revenueShare: number; bonus: number; total: number }[]
      >('/api/salary-runs/me'),
  });
}

export interface DayOffRequest {
  employeeId: string;
  requestDate: string;
  kind: 'required' | 'preferred';
}

export interface AppSettingsDto {
  requiredDaysOffPerMonth: number;
  preferredDaysOffPerMonth: number;
}

export interface PublishConflict {
  employeeId: string;
  employeeName: string;
  workDate: string;
}

export interface PublishAssessment {
  draftCount: number;
  conflicts: { required: PublishConflict[]; preferred: PublishConflict[] };
  /**
   * Employee-days that would end up with two overlapping shifts.
   *
   * A hard blocker, unlike a day-off conflict: publishing these would pay someone twice for the
   * same hours. Optional so the type does not lie about a deployment predating the guard.
   */
  overlaps?: PublishConflict[];
}

/** The publish-refused 409 body, shaped by `packages/api/src/routes/schedulePublications.ts`. */
export interface PublishOverlapBody {
  code: 'publish_overlaps';
  overlaps: PublishConflict[];
}

export function isPublishOverlapBody(body: unknown): body is PublishOverlapBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'publish_overlaps'
  );
}

/**
 * Day-off requests for a month.
 *
 * `employeeId` omitted means "everyone" for a manager and "me" for an employee — the API decides,
 * so the grid and the cabinet share one hook.
 */
export function useDayOffRequests(params: { employeeId?: string; year: number; month: number }) {
  const api = useApi();
  const qs = new URLSearchParams({ year: String(params.year), month: String(params.month) });
  if (params.employeeId) qs.set('employeeId', params.employeeId);
  return useQuery({
    queryKey: ['day-off-requests', params.employeeId ?? null, params.year, params.month],
    queryFn: () => api.get<DayOffRequest[]>(`/api/day-off-requests?${qs}`),
  });
}

export function useSetDayOff() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { employeeId?: string; requestDate: string; kind: 'required' | 'preferred' }) =>
      api.put<DayOffRequest>('/api/day-off-requests', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['day-off-requests'] }),
  });
}

export function useClearDayOff() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, date }: { employeeId: string; date: string }) =>
      api.del<{ deleted: boolean }>(
        `/api/day-off-requests?employeeId=${employeeId}&date=${date}`,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['day-off-requests'] }),
  });
}

export function useAppSettings() {
  const api = useApi();
  return useQuery({ queryKey: ['app-settings'], queryFn: () => api.get<AppSettingsDto>('/api/settings') });
}

export function useUpdateAppSettings() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<AppSettingsDto>) => api.patch<AppSettingsDto>('/api/settings', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['app-settings'] });
      // The remaining-allowance figures in the picker derive from these limits.
      void qc.invalidateQueries({ queryKey: ['day-off-requests'] });
    },
  });
}

export function usePublicationState(params: { year: number; month: number }) {
  const api = useApi();
  return useQuery({
    queryKey: ['schedule-publication', params.year, params.month],
    queryFn: () =>
      api.get<{
        published: boolean;
        publishedAt?: string;
        publishedBy?: string;
        overrideReason?: string;
        // A fix landing in parallel with this task adds the override history to the response;
        // optional so this hook's shape does not lie about older/unpatched deployments.
        overrides?: { reason: string; createdBy: string; createdAt: string }[];
      }>(`/api/schedule-publications?year=${params.year}&month=${params.month}`),
  });
}

export function usePublishPreview() {
  const api = useApi();
  return useMutation({
    mutationFn: (body: { year: number; month: number }) =>
      api.post<PublishAssessment>('/api/schedule-publications/preview', body),
  });
}

export function usePublishMonth() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { year: number; month: number; overrideReason?: string }) =>
      api.post<{ published: number; conflicts: PublishAssessment['conflicts'] }>(
        '/api/schedule-publications',
        body,
      ),
    onSuccess: () => {
      // Publishing changes shift statuses, closes the day-off picker, and makes shifts payable.
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      void qc.invalidateQueries({ queryKey: ['schedule-publication'] });
      void qc.invalidateQueries({ queryKey: ['salary-runs'] });
    },
  });
}
