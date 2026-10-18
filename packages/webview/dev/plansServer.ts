import { approvePlan, createPlan, getPlan, listPlans, loadProject, setPlanStatus, writeVariant, VibeError } from '@vibe-spec/core';
import type { PlansHostMessage } from '../src/plansProtocol.js';

export function createPlansServer(getRoot: () => string) {
  const sessions = new Map<string, string | undefined>();
  return {
    reset() { sessions.clear(); },
    async fixture() {
      const root = getRoot();
      let project = await loadProject(root);
      project = (await createPlan(root, project.revision, 'price-review', {
        title: '묶음 가격 검토', status: 'draft', question: '가격과 수량 중 무엇을 바꿀까요?', sources: [{ file: 'source.xlsx', cell: 'B2' }],
      })).project;
      project = (await writeVariant(root, project.revision, 'price-review', 'A', { set: { 'offers/bundle/price': '150.000' } })).project;
      project = (await writeVariant(root, project.revision, 'price-review', 'B', { set: { 'offers/bundle/count': '2' } })).project;
      return getPlan(project, 'price-review');
    },
    async handle(body: Record<string, unknown>): Promise<PlansHostMessage> {
      const root = getRoot(), client = String(body.client);
      let project = await loadProject(root);
      let name = sessions.get(client);
      if (body.type === 'ready' || body.type === 'planOpen') {
        if (typeof body.name === 'string') { getPlan(project, body.name); name = body.name; }
        sessions.set(client, name);
      }
      if (body.type === 'planStatus' || body.type === 'planApprove') {
        if (name !== body.name) throw new VibeError('INVALID_EDIT', 'Choose the open plan.');
        if (body.type === 'planApprove' && body.confirmed !== true) throw new VibeError('INVALID_EDIT', 'Confirm the variant first.');
        if (body.type === 'planStatus' && body.status !== 'draft' && body.status !== 'review') throw new VibeError('INVALID_EDIT', 'Choose draft or review.');
        project = (body.type === 'planApprove'
          ? await approvePlan(root, String(body.revision), name!, String(body.variant))
          : await setPlanStatus(root, String(body.revision), name!, body.status as 'draft' | 'review')).project;
      }
      const plans = listPlans(project);
      return { type: 'plansState', revision: project.revision, plans, replace: body.type !== 'plansRefresh',
        ...(name ? { selected: name } : {}), ...(plans.some(plan => plan.name === name) ? { view: getPlan(project, name!) } : {}),
        ...(body.type === 'planApprove' ? { notice: '기준안에 반영하고 변경분을 보관했습니다.' } : {}),
      };
    },
  };
}
