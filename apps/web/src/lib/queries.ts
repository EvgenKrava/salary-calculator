import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
export interface Employee {
  id: string;
  name: string;
  levelId: string;
  revenuePercent: number;
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

export function useEmployees() {
  const api = useApi();
  return useQuery({ queryKey: ['employees'], queryFn: () => api.get<Employee[]>('/api/employees') });
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
