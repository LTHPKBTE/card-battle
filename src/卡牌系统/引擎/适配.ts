// 战斗引擎 - 卡牌库卡牌 → 引擎卡牌定义 的适配层
//
// 这里只用结构化类型描述入参, 不 import 卡牌/schema.ts (它依赖酒馆注入的全局 z,
// 而引擎要能在 node 里独立跑测试).

import { parseMachineEffect } from './schema.ts';
import type { CardDefinition, CardProvider } from './types.ts';

/** 卡牌库中的卡牌 (只取引擎需要的字段) */
export interface LibraryCardLike {
  id: string;
  name: string;
  series?: string;
  rarity?: string;
  stars?: number;
  type?: string;
  attribute?: string;
  gender?: string;
  race?: string;
  height?: string;
  /** 允许 "300[+100]" 这类带说明的文本 */
  atk?: string;
  /** 基础护盾值 (旧字段名 def 由卡牌库迁移时改名) */
  shield?: string;
  hp?: string;
  /** 上场要消耗的能量 (允许 "2[+1]" 这类带说明的文本) */
  energy?: string;
  description?: string;
  machine_effect?: unknown;
}

/** 从 "300[+100]" / "1500" 这类文本中取出基础数值 */
export function parseStatText(text: unknown): number {
  const match = String(text ?? '').match(/-?\d+(?:\.\d+)?/);
  return match ? Math.round(Number(match[0])) : 0;
}

/** 适配结果 */
export interface AdaptResult {
  def: CardDefinition;
  /** 机读区校验失败时的原因 (卡牌本身仍然可用) */
  error: string | null;
}

/** 把一张卡牌库卡牌适配为引擎的卡牌定义 */
export function adaptCard(card: LibraryCardLike): AdaptResult {
  const { effects, error } = parseMachineEffect(card.machine_effect);
  return {
    def: {
      id: card.id,
      name: card.name,
      series: card.series ?? '',
      rarity: card.rarity ?? 'N',
      stars: card.stars ?? 0,
      type: card.type ?? '',
      attribute: card.attribute ?? '',
      gender: card.gender ?? '',
      race: card.race ?? '',
      height: card.height ?? '',
      atk: parseStatText(card.atk),
      shield: parseStatText(card.shield),
      hp: parseStatText(card.hp),
      energy: parseStatText(card.energy),
      description: card.description ?? '',
      effects,
    },
    error,
  };
}

/** 卡牌查询提供者与机读区错误 */
export interface CardProviderResult {
  provider: CardProvider;
  /** 各卡机读区的校验错误 (key = 卡牌 id) */
  errors: Record<string, string>;
}

/** 用一组卡牌构造查询提供者 (支持按 id 或卡名查询) */
export function createCardProvider(cards: LibraryCardLike[]): CardProviderResult {
  const by_id = new Map<string, CardDefinition>();
  const by_name = new Map<string, CardDefinition>();
  const errors: Record<string, string> = {};

  for (const card of cards) {
    const { def, error } = adaptCard(card);
    by_id.set(def.id, def);
    if (!by_name.has(def.name)) {
      by_name.set(def.name, def);
    }
    if (error) {
      errors[def.id] = error;
    }
  }

  return {
    provider: ref => by_id.get(ref) ?? by_name.get(ref) ?? null,
    errors,
  };
}
