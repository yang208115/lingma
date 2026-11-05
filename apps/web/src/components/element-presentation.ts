import type { ElementKind } from '@lingma/shared';

export const singletonKinds: readonly ElementKind[] = ['story_premise', 'narrative_style'];
export const worldbuildingTypes: Record<string, readonly string[]> = {
  总设定: ['era', 'geography', 'society', 'rules'],
  地点: ['geography', 'era', 'society'],
  组织: ['society', 'resources', 'rules'],
  体系: ['rules', 'resources', 'cost'],
  物品: ['rules', 'cost', 'resources'],
};
export const primaryElementFields: Record<ElementKind, readonly string[]> = {
  story_premise: ['genre', 'premise', 'theme', 'sellingPoint', 'length'],
  worldbuilding: worldbuildingTypes.总设定 ?? [],
  character: ['role', 'identity', 'goal', 'motivation', 'voice'],
  core_conflict: ['protagonist', 'opposition', 'goals', 'obstacle', 'failureCost'],
  narrative_style: ['pov', 'tone', 'pace', 'dialogue', 'avoid'],
  master_outline: ['opening', 'inciting', 'stages', 'turns', 'climax', 'ending'],
  timeline_event: ['time', 'event', 'cause', 'consequence', 'participants'],
  foreshadow: ['clue', 'surface', 'truth', 'plantedAt', 'payoff', 'progress'],
};
