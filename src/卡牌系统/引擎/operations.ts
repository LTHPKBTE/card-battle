// 战斗引擎 - 操作注册表与内置操作
//
// 机读区里的 operations 只是一串数据, 真正执行的是这里注册的函数.
// 想扩展新的操作类型, 调用 registerOperation() 即可 (不需要改动引擎本体).
//
// 处理器返回值: true = 成功执行 (代价类操作以此判断是否支付得起), false = 无法执行.
//
// 引擎只认 `值.ts` 编译出来的值表达式 AST; 这里用 `valueOf()` / `timesOf()` 求值 ——
// 常量走快速路径, 所以老卡的行为完全不变.

import { evalCondition, evalNumber } from './conditions.ts';
import { nextId } from './ids.ts';
import { addModifier, makeExpiry, removeModifiersByStatus, setStatusModifierStacks } from './modifiers.ts';
import {
  isPlayerTarget,
  type EngineContext,
  type NumberSpec,
  type OperationSpec,
  type StatusRecord,
  type Target,
} from './types.ts';

/** 操作处理器 */
export type OperationHandler = (ctx: EngineContext, spec: OperationSpec) => boolean;

/**
 * 单次效果结算允许执行的操作数上限.
 *
 * 防的是「循环里又触发效果、效果又开循环」这类作者写错导致的失控 ——
 * 超过之后本效果的剩余操作直接不执行, 并留一条警告日志.
 */
export const OP_BUDGET = 800;

/** FOR_EACH 一次最多处理多少个目标 (写 `max` 也不能超过它) */
export const LOOP_ITERATION_LIMIT = 32;

/** REPEAT 一次最多重复多少次 */
export const REPEAT_LIMIT = 64;

/** 循环嵌套层数上限 */
export const LOOP_DEPTH_LIMIT = 4;

/** 用 `condition` 做分支选择的控制流操作 (它们不能用 condition 当「发动前提」) */
const BRANCH_OPS = new Set(['IF']);

const registry = new Map<string, OperationHandler>();

/** 注册 (或覆盖) 一种操作 */
export function registerOperation(type: string, handler: OperationHandler): void {
  registry.set(type, handler);
}

/** 是否已注册某操作 */
export function hasOperation(type: string): boolean {
  return registry.has(type);
}

/** 已注册的操作类型 (文档 / 校验用) */
export function operationTypes(): string[] {
  return [...registry.keys()].sort();
}

/**
 * 求值操作里的数值字段.
 *
 * `fallback` 用于「没写 value 时取另一个来源」(例: DAMAGE 默认用事件数值).
 */
export function valueOf(ctx: EngineContext, spec: NumberSpec | null | undefined, fallback = 0): number {
  return evalNumber(spec, ctx.makeScope(ctx.source, ctx.controller), fallback);
}

/** 求值「次数」类字段 (至少 1 次; 表达式算出小数时向下取整) */
export function timesOf(ctx: EngineContext, spec: NumberSpec | null | undefined, fallback = 1): number {
  return Math.max(1, Math.trunc(valueOf(ctx, spec, fallback)));
}

/**
 * 执行单个操作.
 *
 * 这里是所有失控防护的关口: 操作计数、STOP、以及「condition 不满足就不执行」.
 * `IF` 例外 —— 它的 `condition` 是分支条件而不是发动前提, 所以不在这道门上拦它.
 */
export function runOperation(ctx: EngineContext, spec: OperationSpec): boolean {
  ctx.op_count += 1;
  if (ctx.op_count > OP_BUDGET) {
    if (ctx.op_count === OP_BUDGET + 1) {
      ctx.log(
        'SYSTEM',
        `单个效果的操作数超过 ${OP_BUDGET}, 剩余操作已跳过 (请检查循环/连锁)`,
        { effect: ctx.effect?.label ?? null, source: ctx.source?.name ?? null },
        'WARN',
      );
    }
    return false;
  }
  if (ctx.stopped) {
    return false;
  }
  if (spec.condition && !BRANCH_OPS.has(spec.type)) {
    if (!evalCondition(spec.condition, ctx.makeScope(ctx.source, ctx.controller))) {
      return false;
    }
  }
  const handler = registry.get(spec.type);
  if (!handler) {
    ctx.logInternal('SYSTEM', `未知操作: ${spec.type}`);
    return false;
  }
  return handler(ctx, spec);
}

/** 依次执行一组操作; 返回是否全部执行成功 (STOP / 预算耗尽会提前结束) */
export function runOperations(ctx: EngineContext, specs: readonly OperationSpec[]): boolean {
  let all = true;
  for (const spec of specs) {
    if (ctx.stopped) {
      break;
    }
    if (!runOperation(ctx, spec)) {
      all = false;
    }
  }
  return all;
}

/** 把卡牌目标过滤出来 (忽略玩家目标) */
function cardTargets(ctx: EngineContext, spec: OperationSpec, fallback: Parameters<EngineContext['resolve']>[1]): string[] {
  return ctx.resolve(spec.target, fallback).filter((target: Target) => !isPlayerTarget(target));
}

/** 移除一个状态及其携带的效果与修正 */
export function removeStatus(ctx: EngineContext, status: StatusRecord): void {
  for (const id of status.effects) {
    delete ctx.state.effects[id];
  }
  removeModifiersByStatus(ctx.state, status.id);
  delete ctx.state.statuses[status.id];
  const card = ctx.state.cards[status.target];
  if (card) {
    card.statuses = card.statuses.filter(id => id !== status.id);
  }
}

// ---------------------------------------------------------------------------
// 伤害 / 回复
// ---------------------------------------------------------------------------

registerOperation('DAMAGE', (ctx, spec) => {
  const targets = ctx.resolve(spec.target, 'EVENT_TARGET');
  if (targets.length === 0) {
    return false;
  }
  const source = ctx.source?.id ?? null;
  const value = valueOf(ctx, spec.value, ctx.event?.value ?? 0);
  // pierce: 无视护盾, 伤害全部打在生命上
  const pierce = spec.pierce === true;
  for (const target of targets) {
    const before = ctx.emit({ timing: 'BEFORE_DAMAGE', actor: source, target, source, value });
    if (before.canceled) {
      continue;
    }
    const dealt = ctx.damage(target, before.value, source, { pierce });
    ctx.emit({ timing: 'AFTER_DAMAGE', actor: source, target, source, value: dealt });
  }
  return true;
});

registerOperation('HEAL', (ctx, spec) => {
  const targets = ctx.resolve(spec.target, 'EVENT_TARGET');
  if (targets.length === 0) {
    return false;
  }
  const source = ctx.source?.id ?? null;
  const value = valueOf(ctx, spec.value, 0);
  for (const target of targets) {
    const before = ctx.emit({ timing: 'BEFORE_HEAL', actor: source, target, source, value });
    if (before.canceled) {
      continue;
    }
    const healed = ctx.heal(target, before.value, source);
    ctx.emit({ timing: 'AFTER_HEAL', actor: source, target, source, value: healed });
  }
  return true;
});

/**
 * 恢复护盾: 补回不超过 `shield_max` 的护盾值.
 *
 * 破盾之后可以反复「重新张盾」, 每次补满都算新的一层, 再被打空会再次派发 `SHIELD_BROKEN`.
 * 想把护盾直接清零 (破盾, 不掉血) 请用 `CLEAR_SHIELD`.
 */
registerOperation('RESTORE_SHIELD', (ctx, spec) => {
  const targets = cardTargets(ctx, spec, 'SELF');
  if (targets.length === 0) {
    return false;
  }
  const source = ctx.source?.id ?? null;
  const value = Math.max(0, valueOf(ctx, spec.value, 0));
  let restored = 0;
  for (const id of targets) {
    const card = ctx.card(id);
    if (card) {
      restored += ctx.changeShield(card, value, source);
    }
  }
  return restored > 0;
});

/**
 * 护盾清零: 把目标的当前护盾直接清 0.
 *
 * 不走伤害、不影响生命, 但会正常派发 `SHIELD_BROKEN` (所以「破盾时…」的效果能接上).
 * 常用于「破盾」技能: 先清盾, 再补一刀 `DAMAGE` + `pierce`.
 */
registerOperation('CLEAR_SHIELD', (ctx, spec) => {
  const source = ctx.source?.id ?? null;
  let cleared = 0;
  for (const id of cardTargets(ctx, spec, 'EVENT_TARGET')) {
    const card = ctx.card(id);
    if (card) {
      cleared += -ctx.changeShield(card, -card.current.shield, source);
    }
  }
  return cleared > 0;
});

// ---------------------------------------------------------------------------
// 区域转移
// ---------------------------------------------------------------------------

registerOperation('DESTROY', (ctx, spec) => {
  let any = false;
  for (const id of cardTargets(ctx, spec, 'EVENT_TARGET')) {
    const card = ctx.card(id);
    if (card && ctx.destroy(card, ctx.source?.id ?? null)) {
      any = true;
    }
  }
  return any;
});

registerOperation('MOVE', (ctx, spec) => {
  const zone = spec.zone ?? 'GRAVEYARD';
  let any = false;
  for (const id of cardTargets(ctx, spec, 'EVENT_TARGET')) {
    const card = ctx.card(id);
    if (card) {
      ctx.move(card, zone, { reason: spec.type });
      any = true;
    }
  }
  return any;
});

registerOperation('SUMMON', (ctx, spec) => {
  if (!spec.card) {
    ctx.logInternal('SYSTEM', 'SUMMON 缺少 card 参数');
    return false;
  }
  const owner = spec.data?.owner === 'OPPONENT' ? opponentOf(ctx.controller) : ctx.controller;
  const count = timesOf(ctx, spec.value, 1);
  let any = false;
  for (let i = 0; i < count; i += 1) {
    const card = ctx.createCard(spec.card, owner);
    if (!card) {
      break;
    }
    ctx.move(card, 'FIELD', { reason: 'summon' });
    any = true;
  }
  return any;
});

registerOperation('DRAW', (ctx, spec) => {
  const player = spec.data?.player === 'OPPONENT' ? opponentOf(ctx.controller) : ctx.controller;
  const count = timesOf(ctx, spec.value, 1);
  return ctx.draw(player, count) > 0;
});

/**
 * 攻击: 让来源卡 (或 target 指定的自己场上的卡) 攻击目标.
 *
 * 与玩家手动攻击走同一条结算路径 (BEFORE_ATTACK → 伤害 → AFTER_ATTACK),
 * 因此每回合只能攻击一次, 且会被陷阱等效果取消.
 */
registerOperation('ATTACK', (ctx, spec) => {
  const attacker = ctx.source;
  if (!attacker) {
    return false;
  }
  const targets = ctx.resolve(spec.target, 'EVENT_TARGET');
  if (targets.length === 0) {
    return false;
  }
  // pierce: 这次攻击无视护盾
  return ctx.attack(attacker, targets[0], { pierce: spec.pierce === true });
});

// ---------------------------------------------------------------------------
// 修正 / 状态
// ---------------------------------------------------------------------------

registerOperation('MODIFY', (ctx, spec) => {
  const targets = ctx.resolve(spec.target, 'SELF');
  if (targets.length === 0) {
    return false;
  }
  const stat = spec.stat ?? 'atk';
  const value = valueOf(ctx, spec.value, 0);
  const source = ctx.source?.id ?? null;

  // 当前护盾是池值: 直接增减 (duration 对它没有意义, 上限外面靠 shield_max)
  if (stat === 'shield') {
    let changed = false;
    for (const target of targets) {
      if (isPlayerTarget(target)) {
        continue;
      }
      const card = ctx.card(target);
      if (card && ctx.changeShield(card, value, source) !== 0) {
        changed = true;
      }
    }
    return changed;
  }

  // 当前生命也是池值: 正数当回复、负数当伤害
  if (stat === 'hp') {
    let changed = false;
    for (const target of targets) {
      const actual = value >= 0 ? ctx.heal(target, value, source) : ctx.damage(target, -value, source);
      changed = changed || actual > 0;
    }
    return changed;
  }

  const expiry = makeExpiry(spec.duration);
  for (const target of targets) {
    if (isPlayerTarget(target)) {
      continue;
    }
    addModifier(ctx.state, {
      target,
      stat,
      layer: spec.layer,
      value,
      source,
      effect: ctx.effect?.id ?? null,
      label: ctx.effect?.label ?? null,
      expiry,
      condition: spec.condition ?? null,
    });
  }
  ctx.recalcAll();
  return true;
});

registerOperation('TRANSFER_MAX', (ctx, spec) => {
  const from = ctx.resolve(spec.from, 'SELF').filter((target: Target) => !isPlayerTarget(target));
  const to = ctx.resolve(spec.to, 'EVENT_TARGET').filter((target: Target) => !isPlayerTarget(target));
  if (from.length === 0 || to.length === 0) {
    return false;
  }
  const value = valueOf(ctx, spec.value, 0);
  const stat = spec.stat ?? 'hp_max';
  const expiry = makeExpiry(spec.duration);
  const source = ctx.source?.id ?? null;

  // 当前护盾没有「上限修正」可算, 直接转移池值
  if (stat === 'shield') {
    let removed = 0;
    let added = 0;
    for (const id of from) {
      const card = ctx.card(id);
      if (card) {
        removed += -ctx.changeShield(card, -value, source);
      }
    }
    for (const id of to) {
      const card = ctx.card(id);
      if (card) {
        added += ctx.changeShield(card, value, source);
      }
    }
    ctx.log('MODIFY', `转移 ${removed} 点护盾 (对方获得 ${added})`);
    return removed > 0 || added > 0;
  }

  for (const id of from) {
    addModifier(ctx.state, {
      target: id,
      stat,
      value: -value,
      source,
      effect: ctx.effect?.id ?? null,
      label: ctx.effect?.label ?? null,
      expiry,
    });
  }
  for (const id of to) {
    addModifier(ctx.state, {
      target: id,
      stat,
      value,
      source,
      effect: ctx.effect?.id ?? null,
      label: ctx.effect?.label ?? null,
      expiry,
    });
  }
  ctx.recalcAll();
  ctx.log('MODIFY', `转移 ${value} 点${stat === 'hp_max' ? '生命上限' : '护盾上限'}`);
  return true;
});

registerOperation('APPLY_STATUS', (ctx, spec) => {
  const targets = cardTargets(ctx, spec, 'EVENT_TARGET');
  if (targets.length === 0) {
    return false;
  }
  const key = spec.status ?? spec.name ?? '状态';
  const name = spec.name ?? key;
  const stacks = timesOf(ctx, spec.value, 1);
  const expiry = makeExpiry(spec.duration);
  const source = ctx.source?.id ?? null;

  for (const id of targets) {
    const card = ctx.card(id);
    if (!card) {
      continue;
    }
    const existing = card.statuses
      .map(status_id => ctx.state.statuses[status_id])
      .find((status): status is StatusRecord => Boolean(status) && status.key === key);

    if (existing) {
      existing.stacks += stacks;
      if (expiry) {
        existing.expiry = expiry;
      }
      // 层数增加时, 状态携带的修正也同步放大
      setStatusModifierStacks(ctx.state, existing.id, existing.stacks);
      ctx.log('STATUS', `${card.name} 的「${name}」叠加到 ${existing.stacks} 层`);
      continue;
    }

    const status: StatusRecord = {
      id: nextId(ctx.state, 's'),
      key,
      name,
      source,
      target: card.id,
      stacks,
      effects: [],
      expiry,
      data: {},
    };
    ctx.state.statuses[status.id] = status;
    card.statuses.push(status.id);

    for (const [index, def] of (spec.effects ?? []).entries()) {
      const instance = ctx.createEffect(def, {
        source: card.id,
        controller: card.controller,
        status: status.id,
        index,
      });
      status.effects.push(instance.id);
    }

    for (const modifier of spec.modifiers ?? []) {
      const mod_targets = modifier.target ? ctx.resolve(modifier.target, { id: card.id }) : [card.id];
      for (const mod_target of mod_targets) {
        if (isPlayerTarget(mod_target)) {
          continue;
        }
        addModifier(ctx.state, {
          target: mod_target,
          stat: modifier.stat,
          layer: modifier.layer,
          value: evalNumber(modifier.value, ctx.makeScope(ctx.source, ctx.controller), 0),
          source,
          status: status.id,
          label: name,
          stacks,
          expiry: null,
          condition: modifier.condition ?? null,
        });
      }
    }

    ctx.log('STATUS', `${card.name} 获得「${name}」${stacks > 1 ? ` ${stacks} 层` : ''}`);
  }

  ctx.recalcAll();
  return true;
});

registerOperation('REMOVE_STATUS', (ctx, spec) => {
  const key = spec.status ?? spec.name;
  if (!key) {
    return false;
  }
  let any = false;
  for (const id of cardTargets(ctx, spec, 'EVENT_TARGET')) {
    const card = ctx.card(id);
    if (!card) {
      continue;
    }
    for (const status of card.statuses.map(status_id => ctx.state.statuses[status_id]).filter(Boolean)) {
      if (status.key === key) {
        removeStatus(ctx, status);
        ctx.log('STATUS', `${card.name} 的「${status.name}」被移除`);
        any = true;
      }
    }
  }
  ctx.recalcAll();
  return any;
});

registerOperation('ADD_EFFECT', (ctx, spec) => {
  const targets = cardTargets(ctx, spec, 'SELF');
  if (targets.length === 0 || !spec.effects) {
    return false;
  }
  for (const id of targets) {
    const card = ctx.card(id);
    if (!card) {
      continue;
    }
    for (const [index, def] of spec.effects.entries()) {
      const instance = ctx.createEffect(def, { source: card.id, controller: card.controller, index });
      card.effects.push(instance.id);
    }
  }
  return true;
});

// ---------------------------------------------------------------------------
// 事件干预 / 标记
// ---------------------------------------------------------------------------

registerOperation('CANCEL', (ctx) => {
  if (!ctx.event) {
    return false;
  }
  ctx.event.canceled = true;
  ctx.log('EVENT', `事件 ${ctx.event.timing} 被取消`);
  return true;
});

registerOperation('SCALE_EVENT', (ctx, spec) => {
  if (!ctx.event) {
    return false;
  }
  ctx.event.value = Math.round(ctx.event.value * valueOf(ctx, spec.value, 1));
  return true;
});

registerOperation('SET_FLAG', (ctx, spec) => {
  const targets = cardTargets(ctx, spec, 'SELF');
  if (targets.length === 0 || !spec.data) {
    return false;
  }
  for (const id of targets) {
    const card = ctx.card(id);
    if (!card) {
      continue;
    }
    for (const [key, value] of Object.entries(spec.data)) {
      card.flags[key] = Number(value);
    }
  }
  return true;
});

// ---------------------------------------------------------------------------
// 变量
// ---------------------------------------------------------------------------

/**
 * 写变量.
 *
 * `scope: EFFECT` (默认) 写在本次效果结算的局部帧里 —— 效果结算结束就没了,
 * 但本次效果触发的连锁 (子效果) 能读到它;
 * `scope: BATTLE` 写在战斗状态里, 跨效果跨回合存活, 会随快照存进聊天变量.
 *
 * 局部队量名 `index` / `round` 由循环占用, 不要在循环里写它们.
 */
registerOperation('SET_VAR', (ctx, spec) => {
  const name = spec.var;
  if (!name) {
    ctx.logInternal('SYSTEM', 'SET_VAR 缺少 var (变量名)');
    return false;
  }
  ctx.writeVar(name, valueOf(ctx, spec.value, 0), spec.scope);
  return true;
});

/** 变量累加 (读旧值 + value 再写回; 没有就读作 0) */
registerOperation('ADD_VAR', (ctx, spec) => {
  const name = spec.var;
  if (!name) {
    ctx.logInternal('SYSTEM', 'ADD_VAR 缺少 var (变量名)');
    return false;
  }
  const next = ctx.readVar(name, spec.scope) + valueOf(ctx, spec.value, 0);
  ctx.writeVar(name, next, spec.scope);
  return true;
});

// ---------------------------------------------------------------------------
// 控制流
// ---------------------------------------------------------------------------

/**
 * 条件分支.
 *
 * 注意: IF 的 `condition` 是**分支条件**, 不是「发动前提」——
 * 写成 `{ type: IF, condition: X, then: [...], else: [...] }`,
 * X 成立跑 then, 否则跑 else (没写 else 就什么都不做).
 */
registerOperation('IF', (ctx, spec) => {
  if (!spec.condition) {
    ctx.logInternal('SYSTEM', 'IF 缺少 condition (分支条件)');
    return false;
  }
  const hit = evalCondition(spec.condition, ctx.makeScope(ctx.source, ctx.controller));
  const branch = hit ? spec.then : spec.else;
  if (!branch || branch.length === 0) {
    return true;
  }
  return runOperations(ctx, branch);
});

/**
 * 遍历: 对 `target` 解析出来的每个目标跑一遍 `operations`.
 *
 * 循环体里用 `LOOP_ITEM` 指当前那个目标, 用 `{ var: index }` / `$index` 取序号 (从 0 开始).
 * `max` 限制本轮处理几个 (与循环上限取小); `break_if` 每轮结束后判定, 成立就提前跳出;
 * 循环体里写 `{ type: BREAK }` 也能跳出.
 */
registerOperation('FOR_EACH', (ctx, spec) => {
  const body = spec.operations ?? [];
  if (body.length === 0) {
    return true;
  }
  if (ctx.loop_depth >= LOOP_DEPTH_LIMIT) {
    ctx.log('SYSTEM', `FOR_EACH 嵌套超过 ${LOOP_DEPTH_LIMIT} 层, 已跳过`, { target: spec.target ?? 'SELF' }, 'WARN');
    return false;
  }

  const items = ctx.resolve(spec.target, 'SELF');
  const cap = Math.min(Math.max(0, spec.max ?? LOOP_ITERATION_LIMIT), LOOP_ITERATION_LIMIT, items.length);
  if (cap === 0) {
    return true;
  }

  const prev = { item: ctx.loop_item, index: ctx.loop_index, break_requested: ctx.break_requested };
  const prev_frame_index = ctx.locals.index;
  const depth = ctx.loop_depth;
  ctx.loop_depth = depth + 1;
  let any = false;
  try {
    for (let i = 0; i < cap; i += 1) {
      if (ctx.stopped) {
        break;
      }
      ctx.loop_item = items[i];
      ctx.loop_index = i;
      ctx.locals.index = i;
      any = runOperations(ctx, body) || any;
      if (ctx.break_requested) {
        break;
      }
      if (spec.break_if && evalCondition(spec.break_if, ctx.makeScope(ctx.source, ctx.controller))) {
        break;
      }
    }
  } finally {
    ctx.loop_item = prev.item;
    ctx.loop_index = prev.index;
    ctx.break_requested = false;
    ctx.loop_depth = depth;
    if (prev_frame_index === undefined) {
      delete ctx.locals.index;
    } else {
      ctx.locals.index = prev_frame_index;
    }
  }
  return any;
});

/**
 * 重复: 把 `operations` 跑 `times` 次 (表达式也行).
 *
 * 循环体里用 `{ var: round }` / `$round` 取第几轮 (从 0 开始).
 */
registerOperation('REPEAT', (ctx, spec) => {
  const body = spec.operations ?? [];
  if (body.length === 0) {
    return true;
  }
  if (ctx.loop_depth >= LOOP_DEPTH_LIMIT) {
    ctx.log('SYSTEM', `REPEAT 嵌套超过 ${LOOP_DEPTH_LIMIT} 层, 已跳过`, {}, 'WARN');
    return false;
  }

  const times = Math.min(REPEAT_LIMIT, timesOf(ctx, spec.times, 1));
  const prev = { item: ctx.loop_item, index: ctx.loop_index, break_requested: ctx.break_requested };
  const prev_frame_round = ctx.locals.round;
  const depth = ctx.loop_depth;
  ctx.loop_depth = depth + 1;
  let any = false;
  try {
    for (let i = 0; i < times; i += 1) {
      if (ctx.stopped) {
        break;
      }
      ctx.locals.round = i;
      any = runOperations(ctx, body) || any;
      if (ctx.break_requested) {
        break;
      }
      if (spec.break_if && evalCondition(spec.break_if, ctx.makeScope(ctx.source, ctx.controller))) {
        break;
      }
    }
  } finally {
    ctx.loop_item = prev.item;
    ctx.loop_index = prev.index;
    ctx.break_requested = false;
    ctx.loop_depth = depth;
    if (prev_frame_round === undefined) {
      delete ctx.locals.round;
    } else {
      ctx.locals.round = prev_frame_round;
    }
  }
  return any;
});

/** 跳出最内层循环 (循环外写它没有意义, 会留一条警告) */
registerOperation('BREAK', (ctx) => {
  if (ctx.loop_depth === 0) {
    ctx.logInternal('SYSTEM', 'BREAK 不在循环里, 已忽略');
    return false;
  }
  ctx.break_requested = true;
  return true;
});

/**
 * 停止本效果剩下的操作 (已经排进事件队列的效果照常结算).
 *
 * 多步决策里很有用: 处理完关键分支后就收手, 不让后面的操作再跑.
 */
registerOperation('STOP', (ctx) => {
  ctx.stopped = true;
  return true;
});

/** 取对手玩家 */
function opponentOf(player: 'PLAYER' | 'ENEMY'): 'PLAYER' | 'ENEMY' {
  return player === 'PLAYER' ? 'ENEMY' : 'PLAYER';
}
