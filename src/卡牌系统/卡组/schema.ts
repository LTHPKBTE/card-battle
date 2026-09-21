// 卡组的数据结构定义 (zod 4)
// - 卡组只保存「卡牌 id 列表」(同一 id 出现多次表示多份), 卡牌完整信息在展示/出战时从卡牌库读取
// - 存储位置: 聊天变量, 命名空间 `卡组` (每个对话独立)
// - 出战结果写入聊天变量 `战斗.出战卡组`, 供战斗面板 / AI 读取

import { z } from 'zod';

import { CardSchema } from '../卡牌/schema.ts';

/** 卡组在聊天变量中的命名空间键 */
export const DECK_CHAT_KEY = '卡组';

/** 卡组存储格式的当前版本号 (升级格式时 +1, 并在 data.ts 的 migrations 中登记迁移函数) */
export const DECK_VERSION = 2;

/**
 * 卡组阵营: 我方卡组用于玩家, 敌方卡组用于 AI.
 * 与卡牌库的「阵营」对应 (通用卡两边都能用), 但卡组必须明确属于一边.
 */
export const DECK_FACTIONS = ['我方', '敌方'] as const;
export type DeckFaction = (typeof DECK_FACTIONS)[number];

/** 出战结果写入的聊天变量命名空间 (供战斗面板 / AI 读取) */
export const BATTLE_CHAT_KEY = '战斗';

/** 出战结果在 `战斗` 命名空间中的键 */
export const DEPLOYED_DECK_KEY = '出战卡组';

/** 单个卡组 */
export const DeckSchema = z.object({
  /** 唯一标识 (uuid), 由界面生成 */
  id: z.string(),

  /** 卡组名称 */
  名称: z.string().prefault(''),

  /** 阵营: 我方 / 敌方 (旧数据缺失时视为「我方」) */
  阵营: z.enum(DECK_FACTIONS).prefault('我方'),

  /** 卡牌 id 列表, 同一 id 重复出现表示携带多份 */
  卡牌: z.array(z.string()).prefault([]),

  /** 备注 (自由文本) */
  备注: z.string().prefault(''),

  /** 创建时间戳, 用于保持插入顺序 */
  创建时间: z.coerce.number().prefault(() => 0),
});
export type Deck = z.output<typeof DeckSchema>;
export type DeckInput = z.input<typeof DeckSchema>;

/** 聊天变量中卡组命名空间的结构 */
export const DeckStoreSchema = z
  .object({
    版本: z.coerce.number().prefault(DECK_VERSION),
    卡组: z.record(z.string(), DeckSchema).prefault({}),
    /** 当前出战卡组的 id, 空字符串表示未出战 */
    出战卡组: z.string().prefault(''),
  })
  .prefault({ 版本: DECK_VERSION, 卡组: {}, 出战卡组: '' });
export type DeckStore = z.output<typeof DeckStoreSchema>;

/** 注册到聊天变量的结构 (变量管理器 UI 会据此校验/展示) */
export const DeckChatVariableSchema = z.object({
  [DECK_CHAT_KEY]: DeckStoreSchema.prefault({ 版本: DECK_VERSION, 卡组: {}, 出战卡组: '' }),
});

/**
 * 出战卡组快照 (写入聊天变量 `战斗.出战卡组`).
 *
 * 出战瞬间把卡牌库中的完整卡牌信息复制进来, 之后卡牌库改动不会影响已开始的战斗.
 */
export const DeployedDeckSchema = z
  .object({
    /** 来源卡组 id */
    卡组id: z.string().prefault(''),
    /** 来源卡组名称 */
    名称: z.string().prefault(''),
    /** 来源卡组备注 */
    备注: z.string().prefault(''),
    /** 完整卡牌信息 (重复出现表示多份) */
    卡牌: z.array(CardSchema).prefault([]),
    /** 出战时间 (ISO 字符串) */
    选择时间: z.string().prefault(''),
  })
  .prefault({ 卡组id: '', 名称: '', 备注: '', 卡牌: [], 选择时间: '' });
export type DeployedDeck = z.output<typeof DeployedDeckSchema>;
