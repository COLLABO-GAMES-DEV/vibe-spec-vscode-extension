import type { PlanSummary, PlanView } from '@vibe-spec/core';

export const planStatusLabels = { draft: '기획중', review: '컨펌 전', approved: '확정' } as const;
export type PlansClientMessage = { type: 'ready' | 'plansRefresh' | 'planReload' }
  | { type: 'planOpen'; name: string }
  | { type: 'planStatus'; name: string; revision: string; status: 'draft' | 'review' }
  | { type: 'planApprove'; name: string; revision: string; variant: string; confirmed: true };
export type PlansState = {
  type: 'plansState'; revision: string; plans: PlanSummary[]; selected?: string; view?: PlanView;
  replace: boolean; notice?: string;
};
export type PlansHostMessage = PlansState | { type: 'error'; code: string; message: string };
export interface PlansHost {
  send(message: PlansClientMessage): void;
  subscribe(listener: (message: PlansHostMessage) => void): () => void;
}
