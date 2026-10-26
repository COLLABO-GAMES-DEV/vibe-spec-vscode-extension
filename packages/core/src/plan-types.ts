import type { Cell, Diagnostic } from './types.js';

export type PlanStatus = 'draft' | 'review' | 'approved';
export interface PlanDefinition {
  title: string;
  status: PlanStatus;
  question?: string;
  sources?: unknown[];
  selected?: string;
}
export interface VariantInput {
  documents?: Record<string, string>;
  set?: Record<string, Cell>;
  add?: Record<string, Record<string, Cell>>;
  remove?: string[];
  sources?: unknown[];
}
export interface Variant extends VariantInput {
  document_base_values?: Record<string, string>;
  base_values: Record<string, Cell | Record<string, unknown>>;
  base_missing: string[];
}
export interface PlanSummary extends PlanDefinition { name: string; variants: string[] }
export interface PlanValue { present: boolean; value: unknown }
export interface PlanComparison {
  path: string;
  kind?: 'document';
  baseline: PlanValue;
  alternatives: Record<string, PlanValue>;
}
export interface PlanView {
  revision: string;
  plan: PlanSummary;
  variants: Record<string, Variant>;
  comparison: PlanComparison[];
  diagnostics: Diagnostic[];
}
