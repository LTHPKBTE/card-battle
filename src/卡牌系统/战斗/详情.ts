// 战斗 · 卡牌详情整理 (纯函数, 可在 node 中测试)
//
// 面板的「卡牌详情」弹窗只负责排版, 资料整理放在这里:
// 基础资料 / 数值对比 / 卡上效果 / 卡上状态 / 位置归属.

import type {
  BattleState,
  CardInstance,
  EffectInstance,
  Zone,
} from '../引擎/types.ts';
import { explainStat, formatContribution, STAT_LABELS, type StatBreakdown } from '../引擎/溯源.ts';

/** 触发时点显示名 */
export const TIMING_LABELS: Record<string, string> = {
  BATTLE_START: '战斗开始',
  TURN_START: '回合开始',
  TURN_END: '回合结束',
  SIDE_START: '行动开始',
  SIDE_END: '行动结束',
  SIDE_CHANGE: '换边',
  BEFORE_ATTACK: '攻击宣言前',
  AFTER_ATTACK: '攻击后',
  BEFORE_DAMAGE: '伤害结算前',
  AFTER_DAMAGE: '伤害结算后',
  BEFORE_HEAL: '回复前',
  AFTER_HEAL: '回复后',
  BEFORE_DESTROY: '破坏前',
  AFTER_DESTROY: '破坏后',
  SHIELD_BROKEN: '护盾被打破',
  ON_SUMMON: '上场时',
  ON_LEAVE: '离场时',
  ON_DRAW: '抽牌时',
  ON_RECYCLE: '牌库轮换时',
  MANUAL: '主动发动',
};

/** 区域显示名 */
export const ZONE_LABELS: Record<Zone, string> = {
  DECK: '牌库',
  HAND: '手牌',
  FIELD: '场上',
  GRAVEYARD: '墓地',
  BANISHED: '除外',
};

/** 阵营显示名 */
export const SIDE_LABELS: Record<string, string> = { PLAYER: '我方', ENEMY: '敌方' };

/** 一行「标签 / 内容」 */
export interface DetailRow {
  label: string;
  value: string;
}

/** 一行数值 (当前值 + 基础值 + 变化量) */
export interface StatRow {
  label: string;
  /** 当前值 */
  value: number;
  /** 基础值 */
  base: number;
  /** 当前 - 基础 */
  delta: number;
}

/** 一条卡上效果 */
export interface EffectRow {
  /** 显示名 (机读 id, 没写就用序号) */
  label: string;
  /** 时点显示名 */
  timing: string;
  /** 机读定义 (格式化 JSON) */
  detail: string;
}

/** 一条卡上状态 */
export interface StatusRow {
  label: string;
  stacks: number;
  /** 剩余回合; 永久状态为 null */
  remaining: number | null;
  /** 施加者卡名 (溯不到时为 null) */
  source: string | null;
}

/** 一段「加成来源」区块 (按数值分组) */
export interface TraceRow {
  /** 数值显示名 (ATK / 护盾上限 / 生命上限) */
  label: string;
  /** 当前值 / 基础值 */
  value: number;
  base: number;
  delta: number;
  /** 每一段来源的说明文本 */
  lines: string[];
}

/** 基础资料 (静态字段) */
export function cardInfoRows(card: CardInstance): DetailRow[] {
  return [
    { label: '稀有度', value: card.rarity },
    { label: '星级', value: card.stars > 0 ? '★'.repeat(Math.min(6, card.stars)) : '—' },
    { label: '系列', value: card.series || '—' },
    { label: '类型', value: card.type || '—' },
    { label: '属性', value: card.attribute || '—' },
    { label: '性别', value: card.gender || '—' },
    { label: '种族', value: card.race || '—' },
    { label: '身高', value: card.height || '—' },
  ];
}

/** 数值对比 (当前 vs 基础) */
export function cardStatRows(card: CardInstance): StatRow[] {
  const { base, current } = card;
  return [
    { label: '攻击', value: current.atk, base: base.atk, delta: current.atk - base.atk },
    { label: '护盾', value: current.shield, base: base.shield, delta: current.shield - base.shield },
    { label: '护盾上限', value: current.shield_max, base: base.shield, delta: current.shield_max - base.shield },
    { label: '生命', value: current.hp, base: base.hp, delta: current.hp - base.hp },
    { label: '生命上限', value: current.hp_max, base: base.hp, delta: current.hp_max - base.hp },
  ];
}

/** 位置与归属 */
export function cardPositionRows(card: CardInstance): DetailRow[] {
  const rows: DetailRow[] = [
    { label: '拥有者', value: SIDE_LABELS[card.owner] ?? card.owner },
    { label: '控制者', value: SIDE_LABELS[card.controller] ?? card.controller },
    { label: '所在区域', value: ZONE_LABELS[card.zone] ?? card.zone },
  ];
  if (card.zone === 'FIELD' && card.slot !== null) {
    rows.push({ label: '场上位置', value: `${card.slot + 1} 号位` });
  }
  rows.push({ label: '本回合已攻击', value: card.attacked_this_turn ? '是' : '否' });
  const flags = Object.entries(card.flags);
  if (flags.length > 0) {
    rows.push({ label: '标记', value: flags.map(([key, value]) => `${key}=${value}`).join(', ') });
  }
  return rows;
}

/** 卡上效果 (卡自身携带的, 不含状态带来的) */
export function cardEffectRows(state: BattleState, card: CardInstance): EffectRow[] {
  const instances = card.effects
    .map(id => state.effects[id])
    .filter((item): item is EffectInstance => Boolean(item));
  return instances.map((instance, index) => ({
    label: instance.def.id || `效果 ${index + 1}`,
    timing: instance.def.on ? (TIMING_LABELS[instance.def.on] ?? instance.def.on) : '常驻',
    detail: JSON.stringify(instance.def, null, 2),
  }));
}

/** 卡上状态 */
export function cardStatusRows(state: BattleState, card: CardInstance): StatusRow[] {
  return card.statuses
    .map(id => state.statuses[id])
    .filter(Boolean)
    .map(status => ({
      label: status.name || status.key,
      stacks: status.stacks,
      remaining: status.expiry ? status.expiry.remaining : null,
      source: status.source ? (state.cards[status.source]?.name ?? null) : null,
    }));
}

/**
 * 「加成来源」: 把每个数值拆成「基础值 + 一条条来源」.
 *
 * 面板上看到一个 `ATK +100` 时, 这里能回答「谁给的」:
 * `ATK 750 = 300 +50% ← 「背水一战」 , +200 ← 「愿之芽」`
 */
export function cardTraceRows(
  state: BattleState,
  card: CardInstance,
  options: { include_inactive?: boolean } = {},
): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const stat of ['atk', 'shield_max', 'hp_max'] as const) {
    const breakdown: StatBreakdown = explainStat(state, card, stat);
    const lines = breakdown.contributions
      .filter(contribution => contribution.active || options.include_inactive)
      .map(formatContribution);
    if (lines.length === 0) {
      continue;
    }
    rows.push({
      label: STAT_LABELS[stat],
      value: breakdown.value,
      base: breakdown.base,
      delta: breakdown.delta,
      lines,
    });
  }
  return rows;
}
