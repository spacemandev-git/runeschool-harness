import type { ItemConfigId, SkillName } from './ids.ts';

export interface QuestDef {
  readonly id: string;
  readonly name: string;
  readonly stages: readonly {
    readonly stage: number;
    readonly journal: string;
  }[];
  /** Stage that marks the quest complete. */
  readonly complete: number;
  readonly questPoints: number;
  readonly requirements?: {
    readonly quests?: string[];
    readonly skills?: Partial<Record<SkillName, number>>;
    readonly questPoints?: number;
  };
  readonly rewards?: {
    readonly xp?: Partial<Record<SkillName, number>>;
    readonly items?: { readonly item: ItemConfigId; readonly amount: number }[];
  };
}

export interface QuestProgress {
  readonly quest: string;
  readonly stage: number;
}

export interface PlayerQuestState {
  readonly quests: Record<string, number>;
  readonly flags: Record<string, boolean | number | string>;
  readonly questPoints: number;
}
