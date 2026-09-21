// 战斗引擎 - 效果实例的物化与结算

import { evalCondition, evalNumber } from './conditions.ts';
import { nextId } from './ids.ts';
import { addModifier, makeExpiry } from './modifiers.ts';
import { runOperations } from './operations.ts';
import { resolveTargets } from './selectors.ts';
import {
  isPlayerTarget,
  otherPlayer,
  type BattleState,
  type EffectDefinition,
  type EffectInstance,
  type EngineContext,
  type GameEvent,
  type PlayerId,
} from './types.ts';

/** 物化一个效果实例需要的参数 */
export interface MaterializeOptions {
  /** 来源卡实例 id */
  source: string | null;
  /** 控制者 */
  controller: PlayerId;
  /** 来源状态 id (null = 来自卡牌自身) */
  status?: string | null;
  /** 同源效果的序号, 用于生成稳定的 limit 键 */
  index?: number;
}

/** 把一条效果定义物化为效果实例 */
export function createEffect(
  ctx: EngineContext,
  def: EffectDefinition,
  options: MaterializeOptions,
): EffectInstance {
  const explicit_id = def.id;
  const id = explicit_id ?? `${options.source ?? options.status ?? 'global'}#${options.index ?? 0}`;
  const instance: EffectInstance = {
    id: nextId(ctx.state, 'e'),
    label: explicit_id ?? `效果 ${(options.index ?? 0) + 1}`,
    def: { ...def, id },
    source: options.source,
    controller: options.controller,
    status: options.status ?? null,
    disabled: false,
  };
  ctx.state.effects[instance.id] = instance;

  // 常驻修正: 物化时解析一次目标 (ALL_* 类目标不会自动跟随之后的场上变化)
  if (def.modifiers && def.modifiers.length > 0) {
    const source_card = options.source ? (ctx.state.cards[options.source] ?? null) : null;
    const scope = ctx.makeScope(source_card, options.controller);
    for (const spec of def.modifiers) {
      // 数值表达式在「修正被创建的那一刻」求值, 之后就是固定值
      const value = evalNumber(spec.value, scope, 0);
      for (const target of resolveTargets(scope, spec.target, 'SELF')) {
        if (isPlayerTarget(target)) {
          continue;
        }
        addModifier(ctx.state, {
          target,
          stat: spec.stat,
          layer: spec.layer,
          value,
          source: options.source,
          status: options.status ?? null,
          effect: instance.id,
          label: instance.label,
          continuous: options.status == null,
          // 依附于状态的修正由状态统一管理寿命
          expiry: options.status ? null : makeExpiry(spec.duration),
          condition: spec.condition ?? null,
        });
      }
    }
  }

  return instance;
}

/** 删除某张卡自身的全部效果 (卡离场时调用; 状态带来的效果不受影响) */
export function removeEffectsBySource(ctx: EngineContext, source: string): void {
  for (const instance of Object.values(ctx.state.effects)) {
    if (instance.source === source && instance.status === null) {
      delete ctx.state.effects[instance.id];
    }
  }
}

/** 删除某个状态带来的全部效果 */
export function removeEffectsByStatus(ctx: EngineContext, status: string): void {
  for (const instance of Object.values(ctx.state.effects)) {
    if (instance.status === status) {
      delete ctx.state.effects[instance.id];
    }
  }
}

/** 效果是否处于生效状态 (来源卡必须在允许的区域, 状态带来的效果只看状态本身) */
export function isEffectActive(ctx: EngineContext, instance: EffectInstance): boolean {
  if (instance.disabled) {
    return false;
  }
  if (instance.status !== null) {
    return true;
  }
  if (instance.source === null) {
    return true;
  }
  const card = ctx.state.cards[instance.source];
  if (!card) {
    return false;
  }
  return (instance.def.zones ?? ['FIELD']).includes(card.zone);
}

/**
 * 事件发起者是否满足效果的触发归属要求 (`def.by`, 省略 = SELF).
 *
 * 卡牌上写的「攻击后附加创伤」「上场时…」指的都是**这张卡自己**的事件;
 * 不做这个判断的话, 场上任意一张卡攻击/上场/被破坏都会让这张卡一起发动.
 * 反应型效果 (陷阱等) 写 `by: 'ANY'` 即可恢复「不限制发起者」.
 *
 * 事件由玩家发起时 (TURN_START / TURN_END / SIDE_START / SIDE_CHANGE 等) 无法与卡牌比较,
 * SELF 视为不限制 (那些时点的归属由 `when` 控制); ALLY / ENEMY 改按发起玩家比.
 */
function matchesTriggerOwner(ctx: EngineContext, instance: EffectInstance, event: GameEvent): boolean {
  const by = instance.def.by ?? 'SELF';
  if (by === 'ANY' || instance.source === null) {
    return true;
  }

  const actor_card = event.actor ? ctx.state.cards[event.actor] : undefined;
  if (actor_card) {
    if (by === 'ALLY') {
      return actor_card.controller === instance.controller;
    }
    if (by === 'ENEMY') {
      return actor_card.controller !== instance.controller;
    }
    return event.actor === instance.source;
  }

  if (by === 'ALLY') {
    return event.actor === instance.controller;
  }
  if (by === 'ENEMY') {
    return event.actor === otherPlayer(instance.controller);
  }
  return true;
}

/**
 * 这条效果这次允不允许自动发作 (对应机读区的 `ask`).
 *
 * `ask: true` 的效果属于「重要技能」: 面板会先弹一个确认框, 玩家批准了才发作。
 * 批准名单由调用方放在 `ctx.answers` 里 (面板在攻击/发动前收集, AI 写进决策块的 `answers`);
 * 没人来回答 (`answers === null`) 就按 `ask_default` 处理, 默认照常发作。
 *
 * 时机上必须在这里拦 —— 等到 `runEffect` 再拦就晚了: 事件已经派发完了。
 */
function isAskAllowed(ctx: EngineContext, instance: EffectInstance): boolean {
  if (!instance.def.ask) {
    return true;
  }
  const answers = ctx.answers;
  if (answers === null) {
    return (instance.def.ask_default ?? 'RUN') === 'RUN';
  }
  const def_id = instance.def.id;
  return answers.has(instance.id) || (def_id !== undefined && answers.has(def_id));
}

/** 收集在指定事件发生时触发、且尚未失效的效果, 按优先级降序 */
export function collectTriggers(ctx: EngineContext, event: GameEvent): EffectInstance[] {
  const matched = Object.values(ctx.state.effects).filter(instance => {
    if (
      instance.def.on !== event.timing ||
      !isEffectActive(ctx, instance) ||
      !matchesTriggerOwner(ctx, instance, event)
    ) {
      return false;
    }
    if (isAskAllowed(ctx, instance)) {
      // 次数用尽的理由要留一条日志 —— 否则玩家只看到「技能死活不发动」,
      // 翻遍面板也找不到原因 (机读区的 limit 是静默生效的)
      if (!hasLimitLeft(ctx.state, instance)) {
        ctx.log('EFFECT', `${effectTitle(ctx, instance)} 这次没有发动 (${limitLabel(instance)}已用完)`, {
          effect: instance.def.id ?? '',
          card: instance.source ?? '',
          label: effectName(ctx, instance) ?? '',
        });
        return false;
      }
      return true;
    }
    // 没被批准: 面板/日志要能看到「这张卡本来可以发动」, 否则玩家永远不知道场上有这个技能
    ctx.log(
      'EFFECT',
      `${effectTitle(ctx, instance)} 这次没有发动 (机读区标了 ask, 需要先确认)`,
      { effect: instance.def.id ?? '', timing: event.timing },
    );
    return false;
  });
  return matched.sort((a, b) => (b.def.priority ?? 0) - (a.def.priority ?? 0));
}

/** 使用次数限制的计数器键 (按来源卡区分, 同名卡的不同实例各自计数) */
function limitKey(state: BattleState, instance: EffectInstance): string | null {
  const limit = instance.def.limit;
  if (!limit) {
    return null;
  }
  const scope = limit.per === 'TURN' ? `turn:${state.turn}` : 'battle';
  const owner = instance.source ?? instance.status ?? 'global';
  return `limit:${scope}:${owner}:${instance.def.id}`;
}

/** 一次使用次数限制的当前用量 (面板展示用) */
export interface EffectLimitUsage {
  per: 'TURN' | 'BATTLE';
  /** 限制次数 */
  times: number;
  /** 已经用了几次 */
  used: number;
  /** 还剩几次 */
  left: number;
}

/**
 * 这条效果的使用次数还剩多少 (机读区没写 `limit` 时返回 null).
 *
 * 面板拿它解释「为什么这个技能不发动了」—— `limit` 在引擎里是静默生效的,
 * 不主动查就看不出来.
 */
export function effectLimitUsage(state: BattleState, instance: EffectInstance): EffectLimitUsage | null {
  const limit = instance.def.limit;
  const key = limitKey(state, instance);
  if (!limit || !key) {
    return null;
  }
  const used = state.counters[key] ?? 0;
  return { per: limit.per, times: limit.times, used, left: Math.max(0, limit.times - used) };
}

/** 「本回合」/「整场」 */
export function limitPerLabel(per: 'TURN' | 'BATTLE'): string {
  return per === 'TURN' ? '本回合' : '整场';
}

/** 一次限制的完整说法, 如「本回合 1/2 次」 */
export function describeLimit(usage: EffectLimitUsage): string {
  return `${limitPerLabel(usage.per)} ${usage.used}/${usage.times} 次`;
}

/** 「本回合 2 次」—— 用于「已经用完了」这类句子 */
function limitLabel(instance: EffectInstance): string {
  const limit = instance.def.limit;
  return limit ? `${limitPerLabel(limit.per)} ${limit.times} 次` : '';
}

/** 是否还有剩余使用次数 (不消耗) */
function hasLimitLeft(state: BattleState, instance: EffectInstance): boolean {
  const key = limitKey(state, instance);
  if (!key) {
    return true;
  }
  return (state.counters[key] ?? 0) < (instance.def.limit?.times ?? 1);
}

/** 消耗一次使用次数 */
function consumeLimit(ctx: EngineContext, instance: EffectInstance): void {
  const key = limitKey(ctx.state, instance);
  if (key) {
    ctx.state.counters[key] = (ctx.state.counters[key] ?? 0) + 1;
  }
}

/** 效果显示名 (用于日志) */
export function effectLabel(ctx: EngineContext, instance: EffectInstance): string {
  if (instance.source) {
    const card = ctx.state.cards[instance.source];
    if (card) {
      return card.name;
    }
  }
  if (instance.status) {
    const status = ctx.state.statuses[instance.status];
    if (status) {
      return status.name;
    }
  }
  return '效果';
}

/**
 * 技能名 (机读区里写的 `id`).
 *
 * 没写 `id` 时引擎会替它叫「效果 N」—— 那不算名字, 一张卡只有一条效果时就不念出来
 * (与 `溯源.ts` 的取舍一致); 有多条效果时才用序号区分是哪一条.
 */
export function effectName(ctx: EngineContext, instance: EffectInstance): string | null {
  if (instance.def.id === instance.label) {
    return instance.label;
  }
  const owner = instance.source ? (ctx.state.cards[instance.source] ?? null) : null;
  return owner && owner.effects.length <= 1 ? null : instance.label;
}

/**
 * 日志 / 浮字里的效果标题, 如「「凯尔希」的【医疗指令】」.
 *
 * 以前这里直接拿 `effectLabel` 当标题, 于是「发动」前面永远只有角色名 ——
 * 同一张卡有好几个技能时分不清发动的是哪一个.
 */
export function effectTitle(ctx: EngineContext, instance: EffectInstance): string {
  const owner = `「${effectLabel(ctx, instance)}」`;
  const name = effectName(ctx, instance);
  return name ? `${owner}的【${name}】` : owner;
}

/** 是否为需要玩家主动发动的效果 */
export function isManualEffect(instance: EffectInstance): boolean {
  return instance.def.on === 'MANUAL';
}

/**
 * 检查一个效果此刻能否发动 (不产生任何副作用).
 *
 * 只检查次数限制 / 时点归属 / 触发条件; `cost` 是否付得起要在真正发动时才知道
 * (代价里的操作可能互相依赖, 无法安全地预演).
 */
export function canActivate(ctx: EngineContext, instance: EffectInstance): boolean {
  if (ctx.state.finished) {
    return false;
  }
  if (!isEffectActive(ctx, instance) || !hasLimitLeft(ctx.state, instance)) {
    return false;
  }
  const def = instance.def;
  if (def.when && def.when !== 'ANY') {
    // 时点归属方: 卡牌事件归属行动方, 双方共同参与的时点 (TURN_START / TURN_END) 为 null —— 不限制
    // 玩家主动发动时没有正在结算的事件, 就按当前行动方算
    const owner = ctx.event ? ctx.event.turn_owner : ctx.state.active;
    if (owner !== null) {
      const wanted = def.when === 'CONTROLLER' ? instance.controller : otherPlayer(instance.controller);
      if (owner !== wanted) {
        return false;
      }
    }
  }
  const source_card = instance.source ? (ctx.state.cards[instance.source] ?? null) : null;
  return evalCondition(def.condition, ctx.makeScope(source_card, instance.controller));
}

/**
 * 不能发动的原因 (能发动则返回 null).
 *
 * `canActivate` 只会回一个 false —— 效果发不动时玩家看不出为什么,
 * `limit` 用尽尤其阴: 与「次数太多被削」看起来一模一样。这里把 false 拆成一句人话,
 * 面板与日志拿它解释「这个技能为什么按不动」。
 */
export function activationBlockReason(ctx: EngineContext, instance: EffectInstance): string | null {
  if (ctx.state.finished) {
    return '战斗已经结束';
  }
  if (!hasLimitLeft(ctx.state, instance)) {
    return `${limitLabel(instance)}已用完`;
  }
  if (!isEffectActive(ctx, instance)) {
    return '效果当前不生效';
  }
  return canActivate(ctx, instance) ? null : '发动条件不满足';
}

/**
 * 结算一个效果: 次数限制 → 时点归属 → 触发条件 → 代价 → 消耗次数 → 操作.
 *
 * 次数只在代价付清后才扣除; 代价里的操作按顺序执行, 若中途失败则整条效果不发动,
 * 但已经付出的代价不会退还 (与集换式卡牌的通行做法一致).
 *
 * 结算期间会把上下文的「当前效果 / 来源卡 / 控制者」切换到这个效果上,
 * 这样事件触发和玩家主动发动走的是同一条路径.
 *
 * 同时会推入一层**效果局部变量帧** (`SET_VAR scope EFFECT`): 本次效果 (含它触发的连锁)
 * 写的变量只活到结算结束, 而读取会逐层往外找 —— 子效果能读到父效果写的值.
 * 操作计数 / STOP 也在这里重置: 每个效果各自一份预算, 循环写错也不会把整局拖死.
 */
export function runEffect(ctx: EngineContext, instance: EffectInstance): boolean {
  if (!canActivate(ctx, instance)) {
    return false;
  }

  const previous_effect = ctx.effect;
  const previous_source = ctx.source;
  const previous_controller = ctx.controller;
  const previous_locals = ctx.locals;
  const previous_op_count = ctx.op_count;
  const previous_stopped = ctx.stopped;
  ctx.effect = instance;
  ctx.source = instance.source ? (ctx.state.cards[instance.source] ?? null) : null;
  ctx.controller = instance.controller;
  ctx.locals = Object.create(previous_locals) as Record<string, number>;
  ctx.op_count = 0;
  ctx.stopped = false;
  ctx.break_requested = false;

  try {
    const def = instance.def;
    if (def.cost && def.cost.length > 0) {
      const paid = def.cost.every(spec => runOperations(ctx, [spec]));
      if (!paid) {
        return false;
      }
    }

    consumeLimit(ctx, instance);
    // detail 里带上来源卡与效果名: 面板靠它定位「是哪张卡的哪个技能发动了」
    // (播放动画 / 打出技能名), 日志里也写技能名而不是只写角色名
    ctx.log('EFFECT', `${effectTitle(ctx, instance)} 发动`, {
      effect: instance.def.id ?? '',
      card: instance.source ?? '',
      label: effectName(ctx, instance) ?? '',
    });
    if (def.operations) {
      runOperations(ctx, def.operations);
    }
    return true;
  } finally {
    ctx.effect = previous_effect;
    ctx.source = previous_source;
    ctx.controller = previous_controller;
    ctx.locals = previous_locals;
    ctx.op_count = previous_op_count;
    ctx.stopped = previous_stopped;
    ctx.break_requested = false;
  }
}
