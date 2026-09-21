// 战斗引擎 - 加成 / 减值来源追溯
//
// 面板上看到一个 `ATK +100` 时, 总得能回答「这是谁给的」——
// 这个模块把「基础值 + 每一条修正」拆开, 并把每条修正指回它的来源:
//
//   修正 ← 效果实例 (机读区的某条效果) ← 来源卡
//        ← 状态 (状态也会带修正)      ← 施加状态的卡
//
// 引擎内部一律用 id 作引用, 这里只负责把 id 翻译成看得懂的名字.

import { computeStat, isModifierActive, type ScopeFactory } from './modifiers.ts';
import {
  type BattleState,
  type CardInstance,
  type Modifier,
  type ModifierLayer,
  type StatKey,
} from './types.ts';

/** 数值显示名 */
export const STAT_LABELS: Record<StatKey, string> = {
  atk: 'ATK',
  shield_max: '护盾上限',
  shield: '护盾',
  hp_max: '生命上限',
  hp: '生命',
};

/** 修正层级显示名 */
export const LAYER_LABELS: Record<ModifierLayer, string> = {
  SET: '设定',
  ADD: '加减',
  PERCENT_ADD: '百分比',
  PERCENT_MULT: '倍率',
  OVERRIDE: '覆盖',
};

/** 池值 (不做分层运算, 由伤害/回复直接改写) */
export function isPoolStat(stat: StatKey): boolean {
  return stat === 'hp' || stat === 'shield';
}

/** 一条修正的来源 (已经翻译成人看得懂的名字) */
export interface ModifierSource {
  /** 来源类型: 卡牌常驻 / 技能 / 状态 / 引擎 */
  kind: 'CARD' | 'EFFECT' | 'STATUS' | 'ENGINE';
  card_id: string | null;
  card_name: string | null;
  effect_id: string | null;
  effect_label: string | null;
  status_id: string | null;
  status_name: string | null;
  /** 一行显示文本, 如 「灼热之爪」 · 灼烧 */
  text: string;
}

/** 把一条修正的来源翻译成名字 */
export function describeModifierSource(state: BattleState, modifier: Modifier): ModifierSource {
  const card = modifier.source ? (state.cards[modifier.source] ?? null) : null;
  const status = modifier.status ? (state.statuses[modifier.status] ?? null) : null;
  const instance = modifier.effect ? (state.effects[modifier.effect] ?? null) : null;

  let label = modifier.label ?? instance?.def.id ?? null;
  // 一张卡只有一条效果时, 写「「愿之芽」· 效果 1」反而更难读, 直接省略技能名
  if (card && card.effects.length <= 1) {
    label = null;
  }

  const parts: string[] = [];
  const push = (text: string | null) => {
    if (text && !parts.includes(text)) {
      parts.push(text);
    }
  };
  if (card) {
    push(`「${card.name}」`);
  }
  if (status) {
    push(status.name || status.key);
  }
  push(label);
  if (parts.length === 0) {
    parts.push('引擎');
  }

  const kind: ModifierSource['kind'] =
    status && !card ? 'STATUS' : instance ? 'EFFECT' : card ? 'CARD' : 'ENGINE';

  return {
    kind,
    card_id: card?.id ?? null,
    card_name: card?.name ?? null,
    effect_id: instance?.id ?? null,
    effect_label: label,
    status_id: status?.id ?? null,
    status_name: status ? status.name || status.key : null,
    text: parts.join(' · '),
  };
}

/** 一条修正对数值的贡献 (已在展示层翻译过) */
export interface StatContribution {
  modifier_id: string;
  stat: StatKey;
  layer: ModifierLayer;
  /** 单层数值 */
  value: number;
  /** 叠加层数 */
  stacks: number;
  /** 实际计入的数值 (单层 × 层数; 百分比层是小数, 如 0.5 = +50%) */
  amount: number;
  /** 这一条此刻是否真的生效 */
  active: boolean;
  /** 没生效的原因 (生效时为 null) */
  reason: string | null;
  /** 剩余回合; 永久为 null */
  remaining: number | null;
  source: ModifierSource;
}

/** 一个数值的完整拆分 */
export interface StatBreakdown {
  stat: StatKey;
  /** 卡面基础值 */
  base: number;
  /** 当前值 (与卡面上显示的一致) */
  value: number;
  /** 当前 - 基础 */
  delta: number;
  /** 池值 (护盾 / 生命): 不经过分层运算, contributions 一定为空 */
  pool: boolean;
  contributions: StatContribution[];
}

/** 取卡面基础值 */
function baseOf(card: CardInstance, stat: StatKey): number {
  switch (stat) {
    case 'atk':
      return card.base.atk;
    case 'shield_max':
    case 'shield':
      return card.base.shield;
    case 'hp_max':
    case 'hp':
      return card.base.hp;
  }
}

/** 默认作用域: 以这张卡自己为来源 (与引擎重算时一致) */
function fallbackScope(state: BattleState, card: CardInstance): ScopeFactory {
  return source => ({
    state,
    controller: source?.controller ?? card.controller,
    source: source ?? card,
    event: null,
  });
}

/**
 * 拆开一张卡的某个数值: 基础值 + 每一条修正 (含没生效的那些, 并说明原因).
 *
 * `makeScope` 一般不用传; 传了就用它求值修正自带的条件 (`ctx.makeScope` 也行).
 */
export function explainStat(
  state: BattleState,
  card: CardInstance,
  stat: StatKey,
  makeScope?: ScopeFactory,
): StatBreakdown {
  const scope = makeScope ?? fallbackScope(state, card);
  const base = baseOf(card, stat);

  if (isPoolStat(stat)) {
    const value = stat === 'hp' ? card.current.hp : card.current.shield;
    return { stat, base, value, delta: value - base, pool: true, contributions: [] };
  }

  const value = computeStat(state, card, stat, scope);
  const contributions = Object.values(state.modifiers)
    .filter(modifier => modifier.target === card.id && modifier.stat === stat)
    .map((modifier): StatContribution => {
      const active = isModifierActive(state, modifier, scope);
      let reason: string | null = null;
      if (!active) {
        const source_card = modifier.source ? state.cards[modifier.source] : undefined;
        reason = source_card && source_card.zone !== 'FIELD' ? '来源不在场上' : '条件不满足';
      }
      return {
        modifier_id: modifier.id,
        stat: modifier.stat,
        layer: modifier.layer,
        value: modifier.value,
        stacks: modifier.stacks,
        amount: modifier.value * (modifier.stacks || 1),
        active,
        reason,
        remaining: remainingTurns(state, modifier),
        source: describeModifierSource(state, modifier),
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active));

  return { stat, base, value, delta: value - base, pool: false, contributions };
}

/** 保留一位小数 (去掉多余的 0) */
function round1(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 一条贡献的「差值部分」, 如 `+200` / `+50%` / `×1.5` / `＝300` */
export function contributionDelta(contribution: StatContribution): string {
  const { amount, layer } = contribution;
  switch (layer) {
    case 'SET':
      return `＝${round1(amount)}`;
    case 'OVERRIDE':
      return `⇒${round1(amount)}`;
    case 'PERCENT_ADD':
      return `${amount >= 0 ? '+' : ''}${round1(amount * 100)}%`;
    case 'PERCENT_MULT':
      return `×${round1(1 + amount)}`;
    default:
      return `${amount >= 0 ? '+' : ''}${round1(amount)}`;
  }
}

/** 这条修正还剩几回合: 自带期限用它自己的; 依附于状态的看状态的寿命 */
export function remainingTurns(state: BattleState, modifier: Modifier): number | null {
  if (modifier.expiry) {
    return modifier.expiry.remaining;
  }
  if (modifier.status) {
    const status = state.statuses[modifier.status];
    return status?.expiry ? status.expiry.remaining : null;
  }
  return null;
}

/** 一条贡献的完整文本, 如 `+200 ← 「愿之芽」` */
export function formatContribution(contribution: StatContribution): string {
  const stacks = contribution.stacks > 1 ? ` ×${contribution.stacks}层` : '';
  const leftover = contribution.remaining === null ? '' : ` (${contribution.remaining}T)`;
  const inactive = contribution.active ? '' : `(未生效: ${contribution.reason})`;
  return `${contributionDelta(contribution)}${stacks}${leftover} ← ${contribution.source.text}${inactive}`;
}

/** 一个数值的完整说明, 如 `ATK 500 = 300 +200 ← 「愿之芽」` */
export function formatBreakdown(breakdown: StatBreakdown): string {
  const label = STAT_LABELS[breakdown.stat];
  const parts = breakdown.contributions.map(formatContribution);
  if (breakdown.pool) {
    return `${label} ${breakdown.value} (池值, 由伤害/回复直接改写)`;
  }
  if (parts.length === 0) {
    return `${label} ${breakdown.value}`;
  }
  return `${label} ${breakdown.value} = ${breakdown.base} ${parts.join(' , ')}`;
}

/** 哪些数值需要解释 (池值另说) */
const TRACE_STATS: readonly StatKey[] = ['atk', 'shield_max', 'hp_max'];

/**
 * 把一张卡身上的加成压成一行行短文本, 面板与简报共用.
 *
 * 例: `ATK +200 ← 「愿之芽」`
 */
export function statSourceLines(
  state: BattleState,
  card: CardInstance,
  options: { include_inactive?: boolean } = {},
): string[] {
  const lines: string[] = [];
  for (const stat of TRACE_STATS) {
    const breakdown = explainStat(state, card, stat);
    for (const contribution of breakdown.contributions) {
      if (!contribution.active && !options.include_inactive) {
        continue;
      }
      lines.push(`${STAT_LABELS[stat]} ${formatContribution(contribution)}`);
    }
  }
  return lines;
}
