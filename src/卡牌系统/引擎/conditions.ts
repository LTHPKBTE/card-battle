// 战斗引擎 - 条件求值 与 值表达式求值
//
// 两件事放在一起, 是因为它们互相递归:
// - 条件里可以嵌表达式 (`hp_below: "SELF.hp_max / 2"`, `value: { if: ... }`);
// - 表达式里可以嵌条件 (`{ if: {条件}, then: ..., else: ... }`)
// 而两者又都需要目标解析 (selectors) 与随机数 (rng), 拆开反而会绕回循环依赖.
// 表达式的「语法」在 `值.ts` (卡牌校验期就编译成 AST), 这里只管求值.
import { nextRandom } from './rng.ts';
import { filterCards, hasStatus, resolveTargets } from './selectors.ts';
import {
  isPlayerTarget,
  otherPlayer,
  type AggOp,
  type CardInstance,
  type CompareOp,
  type Condition,
  type EventQuery,
  type NumberSpec,
  type PlayerQuery,
  type ResolveScope,
  type SelfQuery,
  type StatKey,
  type TargetCondition,
  type TargetSpec,
  type ValueExpr,
  type ValueOp,
  type VarScope,
} from './types.ts';

/** 数值比较 */
export function compare(left: number, op: CompareOp, right: number): boolean {
  switch (op) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '=':
      return left === right;
    case '<=':
      return left <= right;
    case '<':
      return left < right;
  }
}

/** 卡牌在当前区域停留的回合数 (进入的那回合为 0) */
export function turnsInZone(state: ResolveScope['state'], card: CardInstance): number {
  return state.turn - card.zone_since_turn;
}

/**
 * 目标「还差多少伤害才会被破坏」.
 *
 * 卡牌默认由护盾先承伤, 所以算的是 当前护盾 + 当前生命 (无视护盾的伤害例外, 这里不区分).
 * 玩家没有护盾, 直接取生命值.
 */
function remainingHp(scope: ResolveScope, target: string | null): number {
  if (!target) {
    return 0;
  }
  if (isPlayerTarget(target)) {
    return scope.state.players[target].hp;
  }
  const card = scope.state.cards[target];
  return card ? card.current.shield + card.current.hp : 0;
}

function evalSelf(query: SelfQuery, scope: ResolveScope): boolean {
  const card = scope.source;
  if (!card) {
    return false;
  }
  return matchesSelfQuery(query, scope, card);
}

/** 对一张具体的卡做「自身查询」(self 条件与 target 条件共用) */
function matchesSelfQuery(query: SelfQuery, scope: ResolveScope, card: CardInstance): boolean {
  const { state } = scope;

  if (query.zone !== undefined && card.zone !== query.zone) {
    return false;
  }
  if (query.hp_below !== undefined && card.current.hp >= evalNumber(query.hp_below, scope)) {
    return false;
  }
  if (query.hp_percent_below !== undefined) {
    const max = card.current.hp_max || 1;
    if (card.current.hp / max >= evalNumber(query.hp_percent_below, scope)) {
      return false;
    }
  }
  if (query.atk_above !== undefined && card.current.atk <= evalNumber(query.atk_above, scope)) {
    return false;
  }
  if (query.turns_in_zone !== undefined && turnsInZone(state, card) < evalNumber(query.turns_in_zone, scope)) {
    return false;
  }
  if (query.has_status !== undefined && !hasStatus(state, card, query.has_status)) {
    return false;
  }
  if (query.stat !== undefined && query.op !== undefined && query.value !== undefined) {
    if (!compare(card.current[query.stat], query.op, evalNumber(query.value, scope))) {
      return false;
    }
  }
  return true;
}

/** 对一个玩家目标做「自身查询」: 只有生命值与 hp/hp_max 有意义 */
function matchesPlayerQuery(query: SelfQuery | TargetCondition, scope: ResolveScope, side: 'PLAYER' | 'ENEMY'): boolean {
  const player = scope.state.players[side];
  if (!player) {
    return false;
  }
  if (query.zone !== undefined || query.has_status !== undefined || query.turns_in_zone !== undefined) {
    return false;
  }
  if (query.hp_below !== undefined && player.hp >= evalNumber(query.hp_below, scope)) {
    return false;
  }
  if (query.hp_percent_below !== undefined) {
    const max = player.hp_max || 1;
    if (player.hp / max >= evalNumber(query.hp_percent_below, scope)) {
      return false;
    }
  }
  // 玩家没有攻击力, 写 atk_above 一律不成立 (与「玩家没有攻击力」这个事实一致)
  if (query.atk_above !== undefined) {
    return false;
  }
  if (query.stat !== undefined && query.op !== undefined && query.value !== undefined) {
    if (query.stat !== 'hp' && query.stat !== 'hp_max') {
      return false;
    }
    if (!compare(player[query.stat], query.op, evalNumber(query.value, scope))) {
      return false;
    }
  }
  return true;
}

function evalEvent(query: EventQuery, scope: ResolveScope): boolean {
  const event = scope.event;
  if (!event) {
    return false;
  }
  if (query.value_above !== undefined && event.value <= evalNumber(query.value_above, scope)) {
    return false;
  }
  if (query.value_below !== undefined && event.value >= evalNumber(query.value_below, scope)) {
    return false;
  }
  if (query.lethal !== undefined) {
    const lethal = event.value >= remainingHp(scope, event.target);
    if (lethal !== query.lethal) {
      return false;
    }
  }
  if (query.target_controller !== undefined) {
    const target = event.target;
    if (!target) {
      return false;
    }
    const owner = isPlayerTarget(target)
      ? target
      : (scope.state.cards[target]?.controller ?? null);
    const wanted = query.target_controller === 'SELF' ? scope.controller : otherPlayer(scope.controller);
    if (owner !== wanted) {
      return false;
    }
  }
  return true;
}

/** 求值一个玩家 (血量) 查询 */
function evalPlayer(query: PlayerQuery, scope: ResolveScope): boolean {
  const wanted = query.controller === 'OPPONENT' ? otherPlayer(scope.controller) : scope.controller;
  const player = scope.state.players[wanted];
  if (!player) {
    return false;
  }

  if (query.hp_below !== undefined && player.hp >= evalNumber(query.hp_below, scope)) {
    return false;
  }
  if (query.hp_percent_below !== undefined) {
    const max = player.hp_max || 1;
    if (player.hp / max >= evalNumber(query.hp_percent_below, scope)) {
      return false;
    }
  }
  if (query.stat !== undefined && query.op !== undefined && query.value !== undefined) {
    if (!compare(player[query.stat], query.op, evalNumber(query.value, scope))) {
      return false;
    }
  }
  return true;
}

/** 求值一个条件 (空条件视为通过) */
export function evalCondition(cond: Condition | undefined | null, scope: ResolveScope): boolean {
  if (!cond) {
    return true;
  }

  if ('all' in cond) {
    return cond.all.every(item => evalCondition(item, scope));
  }
  if ('any' in cond) {
    return cond.any.some(item => evalCondition(item, scope));
  }
  if ('not' in cond) {
    return !evalCondition(cond.not, scope);
  }
  if ('exists' in cond) {
    return filterCards(scope, cond.exists).length > 0;
  }
  if ('count' in cond) {
    return compare(filterCards(scope, cond.count).length, cond.op, evalNumber(cond.value, scope));
  }
  if ('self' in cond) {
    return evalSelf(cond.self, scope);
  }
  if ('event' in cond) {
    return evalEvent(cond.event, scope);
  }
  if ('player' in cond) {
    return evalPlayer(cond.player, scope);
  }
  if ('flag' in cond) {
    const value = scope.source?.flags[cond.flag] ?? 0;
    return compare(value, cond.op, evalNumber(cond.value, scope));
  }
  if ('var' in cond) {
    return compare(readVarOf(scope, cond.var, cond.scope), cond.op, evalNumber(cond.value, scope));
  }
  if ('target' in cond) {
    return evalTargetCondition(cond.target, scope);
  }
  if ('chance' in cond) {
    return nextRandom(scope.state) < cond.chance;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 目标条件 (读中间结果用)
// ---------------------------------------------------------------------------

/**
 * 对解析出来的目标做条件判定.
 *
 * 与 `self` 的区别: 它先把 `of` 解析成目标列表 (可以是 `LOOP_ITEM` / 事件目标 / 查询),
 * 所以能问「刚才打的那张卡现在还在场上吗」这类依赖中间结果的问题.
 */
function evalTargetCondition(query: TargetCondition, scope: ResolveScope): boolean {
  const targets = resolveTargets(scope, query.of, 'SELF');
  const matched = targets.filter(target =>
    isPlayerTarget(target)
      ? matchesPlayerQuery(query, scope, target)
      : (() => {
          const card = scope.state.cards[target];
          return card ? matchesSelfQuery(query as SelfQuery, scope, card) : false;
        })(),
  );

  if (query.count_op !== undefined && query.count_value !== undefined) {
    return compare(matched.length, query.count_op, evalNumber(query.count_value, scope));
  }
  const want = query.exists ?? true;
  return want ? matched.length > 0 : matched.length === 0;
}

// ---------------------------------------------------------------------------
// 值表达式
// ---------------------------------------------------------------------------

/**
 * 求值一个数值字段: 纯数字直接返回, 表达式才走 `evalValue`.
 *
 * 老卡写的全是常量, 所以这条快速路径也是「老卡行为完全不变」的保证.
 */
export function evalNumber(spec: NumberSpec | null | undefined, scope: ResolveScope, fallback = 0): number {
  if (spec === null || spec === undefined) {
    return fallback;
  }
  if (typeof spec === 'number') {
    return spec;
  }
  return evalValue(spec, scope);
}

/** 求值一棵值表达式 */
export function evalValue(expr: ValueExpr, scope: ResolveScope): number {
  switch (expr.kind) {
    case 'const':
      return expr.value;
    case 'op':
      return evalOp(expr.op, expr.args.map(item => evalValue(item, scope)));
    case 'stat':
      return statOf(scope, expr.of, expr.stat);
    case 'var':
      return readVarOf(scope, expr.name, expr.scope);
    case 'agg':
      return evalAgg(scope, expr.op, expr.of, expr.stat);
    case 'event': {
      const event = scope.event;
      if (!event) {
        return 0;
      }
      if (expr.key === 'value') {
        return event.value;
      }
      return event.value >= remainingHp(scope, event.target) ? 1 : 0;
    }
    case 'turn':
      return scope.state.turn;
    case 'random':
      return nextRandom(scope.state);
    case 'if':
      if (evalCondition(expr.condition, scope)) {
        return evalValue(expr.then, scope);
      }
      return expr.else ? evalValue(expr.else, scope) : 0;
    default:
      return 0;
  }
}

/** 一元/二元/多元运算 (除零与取模零都当 0, 不抛异常) */
function evalOp(op: ValueOp, args: number[]): number {
  const first = args[0] ?? 0;
  switch (op) {
    case 'ADD':
      return args.reduce((sum, item) => sum + item, 0);
    case 'SUB':
      return first - (args[1] ?? 0);
    case 'MUL':
      return args.reduce((product, item) => product * item, 1);
    case 'DIV': {
      const divisor = args[1] ?? 0;
      return divisor === 0 ? 0 : first / divisor;
    }
    case 'MOD': {
      const divisor = args[1] ?? 0;
      return divisor === 0 ? 0 : first % divisor;
    }
    case 'POW':
      return first ** (args[1] ?? 0);
    case 'MIN':
      return args.length === 0 ? 0 : Math.min(...args);
    case 'MAX':
      return args.length === 0 ? 0 : Math.max(...args);
    case 'NEG':
      return -first;
    case 'ABS':
      return Math.abs(first);
    case 'FLOOR':
      return Math.floor(first);
    case 'CEIL':
      return Math.ceil(first);
    case 'ROUND':
      return Math.round(first);
    default:
      return 0;
  }
}

/** 读某个目标的某个数值 (玩家只有 hp / hp_max) */
export function statOf(scope: ResolveScope, of: TargetSpec | undefined, stat: StatKey): number {
  const target = resolveTargets(scope, of, 'SELF')[0];
  return target ? statOfTarget(scope, target, stat) : 0;
}

/** 读指定目标 id 的数值 */
function statOfTarget(scope: ResolveScope, target: string, stat: StatKey): number {
  if (isPlayerTarget(target)) {
    const player = scope.state.players[target];
    if (!player) {
      return 0;
    }
    return stat === 'hp' ? player.hp : stat === 'hp_max' ? player.hp_max : 0;
  }
  const card = scope.state.cards[target];
  return card ? card.current[stat] : 0;
}

/** 聚合: 对一批目标求和/计数/取极值/平均 */
function evalAgg(scope: ResolveScope, op: AggOp, of: TargetSpec, stat: StatKey): number {
  const targets = resolveTargets(scope, of, 'ALL_FIELD');
  if (op === 'COUNT') {
    return targets.length;
  }
  const values = targets.map(target => statOfTarget(scope, target, stat));
  if (values.length === 0) {
    return 0;
  }
  switch (op) {
    case 'SUM':
      return values.reduce((sum, item) => sum + item, 0);
    case 'MAX':
      return Math.max(...values);
    case 'MIN':
      return Math.min(...values);
    case 'AVG':
      return values.reduce((sum, item) => sum + item, 0) / values.length;
    default:
      return 0;
  }
}

/** 读变量: 先逐层找效果局部 (原型链自动往上层找), 再找战斗级池 */
export function readVarOf(scope: ResolveScope, name: string, var_scope?: VarScope): number {
  if (var_scope === 'BATTLE') {
    return scope.state.vars?.[name] ?? 0;
  }
  const local = scope.vars?.[name];
  if (typeof local === 'number') {
    return local;
  }
  return scope.state.vars?.[name] ?? 0;
}
