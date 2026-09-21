// 战斗引擎 - 数值分层修正
//
// 最终数值永远是「基础值 + 所有生效修正」重算出来的, 不存中间结果.
// 分层结算顺序固定: SET → ADD → PERCENT_ADD → PERCENT_MULT → OVERRIDE.

import { evalCondition } from './conditions.ts';
import { nextId } from './ids.ts';
import {
  type ResolveScope,
  type BattleState,
  type CardInstance,
  type Condition,
  type DurationSpec,
  type Expiry,
  type Modifier,
  type ModifierLayer,
  type StatKey,
} from './types.ts';

/**
 * 一次重算最多跑多少轮 (见 `recalcAll`).
 *
 * 4 轮足够覆盖「条件读自己/别人的派生值 → 改了又影响别人」这种两三层的链,
 * 同时把互相引用的循环截断在一个固定轮数上, 不让它死循环.
 */
export const RECALC_PASS_LIMIT = 4;

/** 由机读区的 duration 生成运行期到期规则 */
export function makeExpiry(spec: DurationSpec | undefined): Expiry | null {
  if (!spec) {
    return null;
  }
  // tick_owner 已废弃: 回合改成「双方各行动一次」之后不再区分归属, 这里直接忽略它.
  return { remaining: spec.turns, tick_on: spec.tick_on ?? 'TURN_END' };
}

/** 新增一条修正需要的参数 */
export interface AddModifierInput {
  target: string;
  stat: StatKey;
  value: number;
  layer?: ModifierLayer;
  source?: string | null;
  status?: string | null;
  /** 产生这条修正的效果实例 id (源技能) */
  effect?: string | null;
  /** 效果显示名 (溯源展示用) */
  label?: string | null;
  /** 常驻修正 (只在来源卡位于场上时生效), 默认 false */
  continuous?: boolean;
  /** 叠加层数, 默认 1 (ADD / PERCENT_* 的实际值 = value × stacks) */
  stacks?: number;
  expiry?: Expiry | null;
  condition?: Condition | null;
}

/** 新增一条修正 */
export function addModifier(state: BattleState, input: AddModifierInput): Modifier {
  const modifier: Modifier = {
    id: nextId(state, 'm'),
    target: input.target,
    stat: input.stat,
    layer: input.layer ?? 'ADD',
    value: input.value,
    source: input.source ?? null,
    status: input.status ?? null,
    effect: input.effect ?? null,
    label: input.label ?? null,
    stacks: input.stacks ?? 1,
    continuous: input.continuous ?? false,
    expiry: input.expiry ?? null,
    condition: input.condition ?? null,
  };
  state.modifiers[modifier.id] = modifier;
  return modifier;
}

/** 删除一条修正 */
export function removeModifier(state: BattleState, id: string): void {
  delete state.modifiers[id];
}

/** 删除某张卡产生的、不依附于状态的修正 (卡离场时调用) */
export function removeModifiersBySource(state: BattleState, source: string): void {
  for (const modifier of Object.values(state.modifiers)) {
    if (modifier.source === source && modifier.status === null) {
      delete state.modifiers[modifier.id];
    }
  }
}

/** 删除某个状态产生的全部修正 */
export function removeModifiersByStatus(state: BattleState, status: string): void {
  for (const modifier of Object.values(state.modifiers)) {
    if (modifier.status === status) {
      delete state.modifiers[modifier.id];
    }
  }
}

/** 把某个状态带来的修正的层数同步为最新层数 (状态叠加时调用) */
export function setStatusModifierStacks(state: BattleState, status: string, stacks: number): void {
  for (const modifier of Object.values(state.modifiers)) {
    if (modifier.status === status) {
      modifier.stacks = stacks;
    }
  }
}

/** 构造作用域的函数 (由 battle.ts 提供, 用于求值修正自带的条件) */
export type ScopeFactory = (source: CardInstance | null) => ResolveScope;

/**
 * 一条修正此刻是否真的生效 (常驻来源在场 + 自带条件满足).
 *
 * 导出是为了让 `溯源.ts` 能解释「这一条为什么没算进去」.
 */
export function isModifierActive(state: BattleState, modifier: Modifier, makeScope: ScopeFactory): boolean {
  // 常驻修正只在来源卡位于场上时生效
  if (modifier.continuous && modifier.source) {
    const source_card = state.cards[modifier.source];
    if (!source_card || source_card.zone !== 'FIELD') {
      return false;
    }
  }
  if (!modifier.condition) {
    return true;
  }
  const source = modifier.source ? (state.cards[modifier.source] ?? null) : null;
  return evalCondition(modifier.condition, makeScope(source));
}

/**
 * 计算某张卡某个数值的当前值.
 *
 * `hp` / `shield` 是池值, 不做分层运算 (引擎直接增减, 只有上限由 `hp_max` / `shield_max` 控制).
 */
export function computeStat(state: BattleState, card: CardInstance, stat: StatKey, makeScope: ScopeFactory): number {
  if (stat === 'hp') {
    return card.current.hp;
  }
  if (stat === 'shield') {
    return card.current.shield;
  }

  const base =
    stat === 'hp_max' ? card.base.hp : stat === 'shield_max' ? card.base.shield : card.base.atk;
  const modifiers = Object.values(state.modifiers).filter(
    modifier => modifier.target === card.id && modifier.stat === stat && isModifierActive(state, modifier, makeScope),
  );

  let value = base;

  /** ADD / PERCENT_* 的实际值 = value × stacks (叠加层数) */
  const scaled = (modifier: Modifier) => modifier.value * (modifier.stacks || 1);

  // SET: 直接设定基础值, 多个时取最后一个
  const sets = modifiers.filter(modifier => modifier.layer === 'SET');
  if (sets.length > 0) {
    value = sets[sets.length - 1].value;
  }

  // ADD: 加减
  value += modifiers.filter(modifier => modifier.layer === 'ADD').reduce((sum, modifier) => sum + scaled(modifier), 0);

  // PERCENT_ADD: 按当前值的百分比增减
  const percent_add = modifiers
    .filter(modifier => modifier.layer === 'PERCENT_ADD')
    .reduce((sum, modifier) => sum + scaled(modifier), 0);
  value += value * percent_add;

  // PERCENT_MULT: 逐个相乘
  for (const modifier of modifiers) {
    if (modifier.layer === 'PERCENT_MULT') {
      value *= 1 + scaled(modifier);
    }
  }

  // OVERRIDE: 最终覆盖, 多个时取最后一个
  const overrides = modifiers.filter(modifier => modifier.layer === 'OVERRIDE');
  if (overrides.length > 0) {
    value = overrides[overrides.length - 1].value;
  }

  return Math.round(value);
}

/**
 * 重算一张卡的当前数值.
 *
 * 返回「这次重算有没有改动任何数值」—— `recalcAll` 用它判断能不能提前收手.
 */
export function recalcCard(state: BattleState, card: CardInstance, makeScope: ScopeFactory): boolean {
  const atk = Math.max(0, computeStat(state, card, 'atk', makeScope));
  const shield_max = Math.max(0, computeStat(state, card, 'shield_max', makeScope));
  const hp_max = Math.max(0, computeStat(state, card, 'hp_max', makeScope));

  let changed = false;
  if (card.current.atk !== atk) {
    card.current.atk = atk;
    changed = true;
  }
  if (card.current.shield_max !== shield_max) {
    card.current.shield_max = shield_max;
    changed = true;
  }
  if (card.current.hp_max !== hp_max) {
    card.current.hp_max = hp_max;
    changed = true;
  }

  // 上限变小时池值跟着压缩 (护盾被削上限不会留下超出上限的余额)
  const shield = Math.max(0, Math.min(card.current.shield, shield_max));
  if (card.current.shield !== shield) {
    card.current.shield = shield;
    changed = true;
  }
  const hp = Math.max(0, Math.min(card.current.hp, hp_max));
  if (card.current.hp !== hp) {
    card.current.hp = hp;
    changed = true;
  }
  return changed;
}

/**
 * 重算全部卡牌.
 *
 * 修正自带的 `condition` 是读 `current.*` 判定的, 而 `current.*` 正是这一轮要算的东西 ——
 * 所以「阈值写成 `SELF.hp_max * 0.3`」这类写法会比引用它的那一步晚一轮。
 * 这里用**有限轮不动点**解决: 一直算到没有数值再变 (最多 `RECALC_PASS_LIMIT` 轮).
 *
 * 上限同时是**环路保护**: 两条修正互相引用 (A 的条件看 B, B 的条件看 A) 时会来回摆动,
 * 算到上限就停手, 结果取最后一轮 (确定, 不会死循环).
 */
export function recalcAll(state: BattleState, makeScope: ScopeFactory, passes = RECALC_PASS_LIMIT): void {
  const limit = Math.max(1, passes);
  for (let pass = 0; pass < limit; pass += 1) {
    let changed = false;
    for (const card of Object.values(state.cards)) {
      if (recalcCard(state, card, makeScope)) {
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
}
