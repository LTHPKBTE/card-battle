// 战斗引擎 - 核心类型定义
//
// 设计要点
// - 引擎是「纯数据 + 纯函数」: 不依赖 Vue / 酒馆全局, 可在 node 中直接跑测试, 也可整块存进聊天变量做快照.
// - 三类东西严格分开, 这是引擎不退化成 if (卡名 === 'xxx') 的关键:
//     ① 修正 Modifier: 没有生命周期, 随时按层重算最终数值
//     ② 触发 Effect  : 事件驱动, 一次性执行 (来自卡牌机读区)
//     ③ 状态 Status  : 有寿命、可叠加, 自身携带 ① 与 ②
// - 卡牌机读效果 (YAML) 先由 schema.ts 校验成 EffectDefinition, 引擎只认已校验的数据.
import type { StatBreakdown } from './溯源.ts';
/** 玩家/阵营标识 */
export type PlayerId = 'PLAYER' | 'ENEMY';

/** 全部玩家, 顺序固定 (结算遍历用) */
export const PLAYER_IDS: readonly PlayerId[] = ['PLAYER', 'ENEMY'];

/** 取对方玩家 */
export function otherPlayer(id: PlayerId): PlayerId {
  return id === 'PLAYER' ? 'ENEMY' : 'PLAYER';
}

/** 卡牌所处区域 */
export type Zone = 'DECK' | 'HAND' | 'FIELD' | 'GRAVEYARD' | 'BANISHED';

/**
 * 数值键, 分两类:
 *
 * - **重算型** (`atk` / `shield_max` / `hp_max`): 每次都由「基础值 + 生效修正」重新算出, 不存中间结果
 * - **池值** (`shield` / `hp`): 引擎直接增减的当前值 —— `shield` 被护盾结算改写, `hp` 被伤害/回复改写
 *
 * 池值不走分层运算, 想改它们只能用 DAMAGE / HEAL / RESTORE_SHIELD / CLEAR_SHIELD 这类操作,
 * `MODIFY` 修正池值时也是「直接增减当前值」(没有分层与持续时间).
 */
export type StatKey = 'atk' | 'shield_max' | 'shield' | 'hp_max' | 'hp';

/** 变量作用域 (SET_VAR 写入 / `var` 条件读取) */
export type VarScope =
  /** 效果局部: 只活在本次效果结算期间 (包含它触发的连锁), 不带 scope 用这个 */
  | 'EFFECT'
  /** 战斗级: 存在战斗状态里, 跨效果/跨回合存活, 会随快照存进聊天变量 */
  | 'BATTLE';

/** 一元/二元运算 (值表达式里的 op) */
export type ValueOp =
  | 'ADD'
  | 'SUB'
  | 'MUL'
  | 'DIV'
  | 'MOD'
  | 'POW'
  | 'MIN'
  | 'MAX'
  | 'NEG'
  | 'ABS'
  | 'FLOOR'
  | 'CEIL'
  | 'ROUND';

/** 聚合运算 (对一批解析出来的目标做统计) */
export type AggOp = 'SUM' | 'COUNT' | 'MAX' | 'MIN' | 'AVG';

/**
 * 值表达式 (AST).
 *
 * 机读区的「数值」可以是常量, 也可以写成公式:
 *
 * ```yaml
 * value: 100                                          # 常量 (老写法)
 * value: { op: DIV, args: [{ stat: atk, of: SELF }, 2] }   # 结构化: 当前攻击力的一半
 * value: "SELF.atk / 2"                               # 字符串糖, 编译成同一棵树
 * ```
 *
 * **编译发生在卡牌校验时** (`引擎/值.ts` 的 `compileValue`), 引擎运行时只认这棵树 ——
 * 所以写错公式会在保存卡牌时就报错, 而不是等到战斗结算那一刻.
 * 求值在 `引擎/conditions.ts` 的 `evalValue` (那里才有目标解析与随机数).
 */
export type ValueExpr =
  /** 常量 */
  | { kind: 'const'; value: number }
  /** 运算: args 数量由 op 决定 (MIN/MAX 支持多个) */
  | { kind: 'op'; op: ValueOp; args: ValueExpr[] }
  /** 某个目标的某个数值 (玩家目标只认 hp / hp_max) */
  | { kind: 'stat'; stat: StatKey; of: TargetSpec }
  /** 读变量: 先找效果局部, 再找战斗级, 都没有就是 0 */
  | { kind: 'var'; name: string; scope: VarScope }
  /** 聚合: 对一批目标求和/计数/极值/平均 */
  | { kind: 'agg'; op: AggOp; of: TargetSpec; stat: StatKey }
  /** 当前事件的数值 / 是否致命 */
  | { kind: 'event'; key: 'value' | 'lethal' }
  /** 当前回合数 */
  | { kind: 'turn' }
  /** 引擎随机数 [0, 1) (按种子, 回放可复现) */
  | { kind: 'random' }
  /** 分支: 条件成立取 then, 否则取 else (没有 else 就是 0) */
  | { kind: 'if'; condition: Condition; then: ValueExpr; else: ValueExpr | null };

/**
 * 可写的「数值」: 常量, 或一个值表达式.
 *
 * 引擎里所有数值字段都用它 (操作的 value / 修正的 value / 条件里的比较值),
 * 所以 `evalNumber()` 对纯数字走快速路径, 老卡的行为完全不变.
 */
export type NumberSpec = number | ValueExpr;

/**
 * 修正层级. 结算顺序固定为 SET → ADD → PERCENT_ADD → PERCENT_MULT → OVERRIDE,
 * 同层内可交换, 跨层顺序确定 → 结果可复现.
 */
export type ModifierLayer = 'SET' | 'ADD' | 'PERCENT_ADD' | 'PERCENT_MULT' | 'OVERRIDE';

/** 修正层级的结算顺序 */
export const MODIFIER_LAYERS: readonly ModifierLayer[] = [
  'SET',
  'ADD',
  'PERCENT_ADD',
  'PERCENT_MULT',
  'OVERRIDE',
];

/** 比较运算符 */
export type CompareOp = '>' | '>=' | '=' | '<=' | '<';

/** 触发时点 (事件类型) */
export type Timing =
  /** 战斗开始 */
  | 'BATTLE_START'
  /**
   * 回合开始.
   *
   * 一个回合 = **双方各行动一次**。这个时点属于整轮, 没有归属方
   * (所以 `turn_owner` 为 null, 写 `when: CONTROLLER` 也会照常触发).
   */
  | 'TURN_START'
  /**
   * 回合结束 = **回合结算时点**.
   *
   * 双方都行动完之后派发, 回合制持续伤害 (DoT) 就写在这里;
   * 事件结算完之后引擎才流逝持续时间 (状态 / 修正的剩余回合数)。
   * 与 `TURN_START` 一样属于整轮, 没有归属方。
   */
  | 'TURN_END'
  /**
   * 某一方开始行动. `actor` = 该玩家, `data.side_index` = 本回合第几个行动方 (0 / 1).
   *
   * 「我方行动开始时」这类效果写 `when: CONTROLLER` 就只在自己这一半触发。
   */
  | 'SIDE_START'
  /** 某一方结束行动 (该方收手之后, 换边之前). `actor` = 该玩家 */
  | 'SIDE_END'
  /**
   * 换边: 行动方从一方交给另一方. `actor` = **接手的那一方**, `data.from` = 交棒的那一方.
   *
   * 每回合会派发 2 次: 「先手 → 后手」与「后手 → 下回合先手」。
   * 需要「每次换边都触发」的效果写这个时点 (旧版写在 `TURN_END` 上的半边效果应该改到这里)。
   */
  | 'SIDE_CHANGE'
  /** 攻击宣言后、伤害结算前 */
  | 'BEFORE_ATTACK'
  /** 攻击完全结算后 */
  | 'AFTER_ATTACK'
  /** 伤害结算前 (可修改 value / 取消) */
  | 'BEFORE_DAMAGE'
  /** 伤害结算后 */
  | 'AFTER_DAMAGE'
  /**
   * 护盾被打破. 护盾从「有」掉到 0 的那一刻派发, 在溢出到生命的伤害结算**之前**.
   *
   * - `actor` / `target` 都是**破盾的那张卡**(不是攻击者), 所以默认 `by: SELF` 恰好是「本卡破盾时」
   * - `source` 是打破它的来源卡 (可能是 null), `value` 是被护盾吃掉的伤害
   * - 护盾重新生成后再被打空会**再次**派发, 不会被记住已经破过盾
   */
  | 'SHIELD_BROKEN'
  /** 回复前 */
  | 'BEFORE_HEAL'
  /** 回复后 */
  | 'AFTER_HEAL'
  /** 破坏前 (可取消) */
  | 'BEFORE_DESTROY'
  /** 破坏后 (已进入墓地) */
  | 'AFTER_DESTROY'
  /** 卡牌进入场上 */
  | 'ON_SUMMON'
  /** 卡牌离开场上 (区域已经改变) */
  | 'ON_LEAVE'
  /** 抽牌后 */
  | 'ON_DRAW'
  /** 牌库抽空、把墓地洗回牌库时 */
  | 'ON_RECYCLE';

/**
 * 效果的触发方式: 一个时点, 或 'MANUAL' (不自动触发, 需玩家主动发动).
 *
 * 'MANUAL' 不是事件, 永远不会被 collectTriggers 收集, 只能通过
 * battle.ts 的 activate() / listActivatable() 使用.
 */
export type EffectTiming = Timing | 'MANUAL';

/**
 * 事件必须由谁发起, 效果才会触发 (`EffectDefinition.by`).
 *
 * - `SELF`: 发起者必须是本效果所属的卡 (默认) —— 「本卡攻击后」「本卡上场时」
 * - `ALLY`: 发起者是本卡控制者的卡 (或该玩家本人) —— 「我方任何卡攻击后」
 * - `ENEMY`: 发起者是对手的卡 (或对手本人) —— 「被攻击时反击」
 * - `ANY`: 不限制发起者 —— 陷阱等反应型效果
 */
export type TriggerOwner = 'SELF' | 'ALLY' | 'ENEMY' | 'ANY';

/** 目标: 卡牌实例 id, 或玩家 id */
export type Target = string;

/** 判断目标是否为玩家 */
export function isPlayerTarget(target: Target): target is PlayerId {
  return target === 'PLAYER' || target === 'ENEMY';
}

/**
 * 排序方式.
 *
 * `SHIELD_DESC` 按**当前护盾值**(池值, 可能已被打空)排序, 与 `HP_ASC` 的口径一致;
 * 想按护盾上限排序请自己写条件查询。
 */
export type SortKey =
  | 'ATK_DESC'
  | 'ATK_ASC'
  | 'SHIELD_DESC'
  | 'SHIELD_ASC'
  | 'HP_ASC'
  | 'HP_DESC'
  | 'RANDOM';

/** 卡牌筛选条件 (只描述"哪些卡", 不含数量与排序) */
export interface CardQuery {
  zone?: Zone;
  /** 控制者视角 */
  controller?: 'SELF' | 'OPPONENT';
  /** 拥有者视角 */
  owner?: 'SELF' | 'OPPONENT';
  series?: string;
  type?: string;
  name?: string;
  rarity?: string;
  /** 拥有指定状态 */
  has_status?: string;
  /** 排除效果来源卡自身 */
  exclude_self?: boolean;
  /** 排除当前事件的目标 */
  exclude_event_target?: boolean;
}

/** 目标查询: 筛选 + 数量 + 排序 */
export interface TargetQuery extends CardQuery {
  /** 最多取几个, 省略 = 全部 */
  max?: number;
  sort?: SortKey;
}

/** 目标描述: 固定关键字 / 直接指定 id / 查询 */
export type TargetSpec =
  /** 效果来源卡自身 */
  | 'SELF'
  /** 效果控制者 (玩家) */
  | 'CONTROLLER'
  /** 效果控制者的对手 (玩家) */
  | 'OPPONENT'
  /** 当前事件的发起者 */
  | 'EVENT_ACTOR'
  /** 当前事件的目标 */
  | 'EVENT_TARGET'
  /** 当前事件的来源卡 */
  | 'EVENT_SOURCE'
  /** 自己场上全部卡 */
  | 'ALL_ALLIES'
  /** 对手场上全部卡 */
  | 'ALL_ENEMIES'
  /** 双方场上全部卡 */
  | 'ALL_FIELD'
  /** 自己场上随机一张 */
  | 'RANDOM_ALLY'
  /** 对手场上随机一张 */
  | 'RANDOM_ENEMY'
  /** FOR_EACH 里当前正在处理的那张卡 (循环外解析为空) */
  | 'LOOP_ITEM'
  /** 直接指定卡牌实例 */
  | { id: string }
  | TargetQuery;

/** 持续时间的递减规则 (运行期).
 *
 * 寿命以**回合**为单位: 每个回合的 `TURN_END` 之前按 `tick_on` 流逝一次.
 */
export interface Expiry {
  /** 剩余次数 (回合数) */
  remaining: number;
  /** 在哪个时点递减 */
  tick_on: 'TURN_START' | 'TURN_END';
}

/** 机读区书写的持续时间 */
export interface DurationSpec {
  /** 持续回合数 (一个回合 = 双方各行动一次) */
  turns: number;
  /** 在哪个时点递减, 默认 TURN_END (即回合结算时) */
  tick_on?: 'TURN_START' | 'TURN_END';
  /**
   * 已废弃: 回合改成「双方各行动一次」之后, 流逝不再区分归属 —— 写了也不改变任何行为.
   *
   * 保留这个键只是为了旧卡还能通过校验; 新写法不要用它.
   */
  tick_owner?: 'CONTROLLER' | 'OPPONENT' | 'ANY';
}

/** 条件: 全部/任一/取反 组合, 或一个叶子谓词 */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  /** 存在满足条件的卡 */
  | { exists: CardQuery }
  /** 满足条件的卡数量比较 */
  | { count: CardQuery; op: CompareOp; value: NumberSpec }
  /** 对来源卡自身的查询 */
  | { self: SelfQuery }
  /** 对当前事件的查询 */
  | { event: EventQuery }
  /** 对玩家 (生命值) 的查询 */
  | { player: PlayerQuery }
  /** 来源卡上的标记比较 (SET_FLAG 写入) */
  | { flag: string; op: CompareOp; value: NumberSpec }
  /** 变量比较 (SET_VAR 写入; 省略 scope 时先读效果局部, 再读战斗级) */
  | { var: string; op: CompareOp; value: NumberSpec; scope?: VarScope }
  /** 对「解析出来的目标」做查询 (循环变量 LOOP_ITEM / 事件目标 / 一张具体的卡) */
  | { target: TargetCondition }
  /** 按种子随机, 概率 0-1 */
  | { chance: number };

/**
 * 对解析出来的目标做条件判定.
 *
 * 与 `self` (只查来源卡) 的区别是它先解析目标 (可以是 `LOOP_ITEM` / 事件目标 / 查询结果),
 * 所以能写出「先打一下, 看它死了没」这种依赖中间结果的多步决策:
 *
 * ```yaml
 * condition: { target: { of: LOOP_ITEM, zone: FIELD } }   # 它现在还在场上吗
 * condition: { target: { of: EVENT_TARGET, hp_below: 1 } } # 它还剩血吗
 * ```
 */
export interface TargetCondition {
  /** 查哪个目标, 默认 SELF */
  of?: TargetSpec;
  /** 期望「至少一个满足」(默认 true); 写成 false 就是「一个都不能满足」 */
  exists?: boolean;
  zone?: Zone;
  /** 当前生命值低于 */
  hp_below?: NumberSpec;
  /** 当前生命值百分比低于 (0-1) */
  hp_percent_below?: NumberSpec;
  /** 攻击力高于 */
  atk_above?: NumberSpec;
  /** 在当前区域停留的回合数 (进入的那回合为 0) */
  turns_in_zone?: NumberSpec;
  has_status?: string;
  /** 数值比较: stat 与 value 用 op 比较 */
  stat?: StatKey;
  op?: CompareOp;
  value?: NumberSpec;
  /** 换成「满足上面这些查询的目标数量」比较 (与 stat/op/value 分开写) */
  count_op?: CompareOp;
  count_value?: NumberSpec;
}

/** 针对效果来源卡自身的条件 */
export interface SelfQuery {
  zone?: Zone;
  /** 当前生命值低于 */
  hp_below?: NumberSpec;
  /** 当前生命值百分比低于 (0-1) */
  hp_percent_below?: NumberSpec;
  /** 攻击力高于 */
  atk_above?: NumberSpec;
  /** 在当前区域停留的回合数 (含进入的那回合为 0) */
  turns_in_zone?: NumberSpec;
  has_status?: string;
  /** 数值比较: stat 与 value 用 op 比较 */
  stat?: StatKey;
  op?: CompareOp;
  value?: NumberSpec;
}

/** 针对当前事件的条件 */
export interface EventQuery {
  /** 事件数值大于 */
  value_above?: NumberSpec;
  /** 事件数值小于 */
  value_below?: NumberSpec;
  /** 该次伤害是否致命 */
  lethal?: boolean;
  /** 事件目标属于哪一方 */
  target_controller?: 'SELF' | 'OPPONENT';
}

/** 针对玩家的条件 (血量判定等) */
export interface PlayerQuery {
  /** 查哪一方, 默认 SELF (效果控制者) */
  controller?: 'SELF' | 'OPPONENT';
  /** 剩余生命值低于 */
  hp_below?: NumberSpec;
  /** 剩余生命值百分比低于 (0-1) */
  hp_percent_below?: NumberSpec;
  /** 数值比较 (目前只有 hp / hp_max 有意义) */
  stat?: 'hp' | 'hp_max';
  op?: CompareOp;
  value?: NumberSpec;
}

/** 常驻修正的描述 (来自机读区) */
export interface ModifierSpec {
  stat: StatKey;
  /** 默认 ADD */
  layer?: ModifierLayer;
  /** 数值; 表达式在「修正被创建的那一刻」求值, 之后就是固定值 */
  value: NumberSpec;
  /** 修正目标, 默认 SELF */
  target?: TargetSpec;
  /** 持续时间, 省略 = 永久 (直到来源离场或状态被移除) */
  duration?: DurationSpec;
  /** 满足条件时才计入 */
  condition?: Condition;
}

/** 操作描述 (来自机读区) */
export interface OperationSpec {
  type: string;
  /** 目标, 默认依操作而定 */
  target?: TargetSpec;
  /** 转移类操作的来源 */
  from?: TargetSpec;
  /** 转移类操作的去向 */
  to?: TargetSpec;
  /** 数值 (常量或值表达式) */
  value?: NumberSpec;
  /** 数值字段 */
  stat?: StatKey;
  /** 修正层级 */
  layer?: ModifierLayer;
  /** 状态标识 (同类状态叠加) */
  status?: string;
  /** 状态显示名 */
  name?: string;
  /** 持续时间 */
  duration?: DurationSpec;
  /** 卡牌引用 (卡牌库 id 或卡名), 用于召唤/检索 */
  card?: string;
  /** DAMAGE / ATTACK 专用: 无视护盾, 伤害全部打在生命上 */
  pierce?: boolean;
  /** 目标区域 */
  zone?: Zone;
  /** 携带的效果定义 (APPLY_STATUS / ADD_EFFECT) */
  effects?: EffectDefinition[];
  /** 携带的常驻修正 (APPLY_STATUS) */
  modifiers?: ModifierSpec[];
  /** 取消的对象: EVENT / DAMAGE / DESTROY / ATTACK */
  cancel?: string;
  /** 条件 */
  condition?: Condition;
  /**
   * 控制流 (IF / FOR_EACH / REPEAT).
   *
   * - `IF`: 走 `then` / `else` 里的操作数组
   * - `FOR_EACH`: 对 `target` 解析出来的每一张卡跑一遍 `operations` (循环体里用 `LOOP_ITEM`)
   * - `REPEAT`: 把 `operations` 重复 `times` 次
   */
  then?: OperationSpec[];
  /** IF 条件不成立时走这里 */
  else?: OperationSpec[];
  /** FOR_EACH / REPEAT 的循环体 */
  operations?: OperationSpec[];
  /** FOR_EACH / REPEAT: 每轮结束后判断, 成立就提前跳出 */
  break_if?: Condition;
  /** REPEAT 的重复次数 */
  times?: NumberSpec;
  /** FOR_EACH 最多处理多少个目标, 默认 32 (上限也是 32) */
  max?: number;
  /** SET_VAR / ADD_VAR 写到哪个作用域, 默认 EFFECT (只活在本次效果结算期间) */
  scope?: VarScope;
  /** SET_VAR / ADD_VAR 的变量名 (与条件 `{ var }` 同名) */
  var?: string;
  /** 自由数据 (SET_FLAG 等) */
  data?: Record<string, unknown>;
}

/** 一条效果定义 (机读区的一条 triggers 项) */
export interface EffectDefinition {
  /** 唯一标识 (省略时按序号自动生成), 也用于使用次数统计 */
  id?: string;
  /** 触发时点; 省略 = 常驻效果, 只提供 modifiers; 'MANUAL' = 玩家主动发动 */
  on?: EffectTiming;
  /** 触发条件 */
  condition?: Condition;
  /** 结算优先级, 大者先 */
  priority?: number;
  /** 发动代价: 任一操作无法执行则不发动 */
  cost?: OperationSpec[];
  /** 效果操作 */
  operations?: OperationSpec[];
  /** 常驻修正 */
  modifiers?: ModifierSpec[];
  /** 使用次数限制 */
  limit?: { per: 'TURN' | 'BATTLE'; times: number };
  /** 只在该时点归属指定方时触发, 默认 ANY */
  when?: 'CONTROLLER' | 'OPPONENT' | 'ANY';
  /**
   * 事件必须由谁发起才触发, 默认 SELF.
   *
   * 事件的主角 (GameEvent.actor) 通常是卡 (攻击者 / 被召唤的卡 / 被破坏的卡),
   * 省略 `by` 时只认「本卡自己」的事件; 反应型效果 (陷阱、同伴上场时…) 要显式写
   * 'ALLY' / 'ENEMY' / 'ANY'.
   *
   * 事件由玩家发起时 (TURN_START / TURN_END / ON_RECYCLE 等) 不做 SELF 判断,
   * 那些时点的归属用 `when` 控制.
   */
  by?: TriggerOwner;
  /**
   * 来源卡需要处于哪些区域该效果才生效, 默认 ['FIELD'].
   * 例: 抽牌时触发的效果写 ['HAND', 'FIELD']; 在墓地生效的写 ['GRAVEYARD'].
   */
  zones?: Zone[];
  /**
   * 发动前先问玩家一句 (默认 false).
   *
   * 只有「重要技能」才该打开它 —— 面板会为每条这样的效果弹一次确认,
   * 打得太多就是刷屏. 玩家忘了自己场上有哪些技能时,
   * 面板的确认框 (以及日志里的「待确认」记录) 就是提醒.
   */
  ask?: boolean;
  /**
   * 没人来回答时怎么处理, 默认 `RUN` (照常发动).
   *
   * 「不回答就不发动」写 `SKIP` —— 适合那种「不带负面代价但会花掉资源的可选动作」.
   */
  ask_default?: 'RUN' | 'SKIP';
}

/** 机读区整体结构 */
export interface MachineEffect {
  effects?: EffectDefinition[];
}

/** 卡牌定义: 引擎视角的卡牌静态数据 (由卡牌库适配而来) */
export interface CardDefinition {
  id: string;
  name: string;
  series: string;
  rarity: string;
  stars: number;
  type: string;
  attribute: string;
  gender: string;
  race: string;
  height: string;
  atk: number;
  /** 基础护盾值 */
  shield: number;
  hp: number;
  /**
   * 上场要消耗的能量 (0 = 免费).
   *
   * 名字故意用通用的「能量」而不是「费用 / 法力」—— 这套脚本会跟着角色卡
   * 走到不同的酒馆角色里, 通用词才不会碰上别的世界观冲突.
   */
  energy: number;
  description: string;
  effects: EffectDefinition[];
}

/** 按 id 或卡名查询卡牌定义 */
export type CardProvider = (ref: string) => CardDefinition | null;

/** 战斗中的一张卡 */
export interface CardInstance {
  /** 战斗内唯一 id */
  id: string;
  /** 卡牌库中的卡牌 id */
  card_id: string;
  name: string;
  series: string;
  rarity: string;
  stars: number;
  type: string;
  attribute: string;
  gender: string;
  race: string;
  height: string;
  /** 拥有者, 不会改变 */
  owner: PlayerId;
  /** 控制者, 可被夺取 */
  controller: PlayerId;
  zone: Zone;
  /** 场上位置, 非场上为 null */
  slot: number | null;
  /** 卡面基础数值 */
  base: { atk: number; shield: number; hp: number };
  /** 上场要消耗的能量 (卡面费用, 从卡牌库快照过来) */
  energy: number;
  /**
   * 当前数值.
   *
   * `atk` / `shield_max` / `hp_max` 由 modifiers 重算, `shield` / `hp` 是池值:
   * 护盾被伤害按顺序吃掉, 打空后伤害溢出到生命; `current.shield` 永远在 0 ~ `current.shield_max` 之间.
   */
  current: { atk: number; shield_max: number; shield: number; hp_max: number; hp: number };
  /** 卡自身携带的效果 (已物化) */
  effects: string[];
  /** 附加状态 id */
  statuses: string[];
  /** 自由标记, 供条件 { flag } 读取 */
  flags: Record<string, number>;
  /** 进入当前区域时的回合数 */
  zone_since_turn: number;
  /** 本回合是否已攻击过 */
  attacked_this_turn: boolean;
}

/** 已物化的效果实例 */
export interface EffectInstance {
  id: string;
  /** 显示名: 机读区里写的 id, 没写就是「效果 N」(溯源展示用) */
  label: string;
  def: EffectDefinition;
  /** 来源卡实例 id */
  source: string | null;
  /** 控制者 */
  controller: PlayerId;
  /** 来自哪个状态 (null 表示来自卡牌自身) */
  status: string | null;
  /** 是否失效 */
  disabled: boolean;
}

/** 一条修正 */
export interface Modifier {
  id: string;
  /** 被修正的卡实例 id */
  target: string;
  stat: StatKey;
  layer: ModifierLayer;
  value: number;
  /** 来源卡实例 id */
  source: string | null;
  /** 来源状态 id (状态带来的修正) */
  status: string | null;
  /** 产生这条修正的效果实例 id (源技能); null = 来源不明 (引擎直接加的) */
  effect: string | null;
  /** 效果显示名 (用于溯源展示, 如机读区里写的 id) */
  label: string | null;
  /**
   * 叠加层数 (来自状态的层数).
   * ADD / PERCENT_ADD / PERCENT_MULT 的实际值 = value × stacks;
   * SET / OVERRIDE 忽略层数 (取最后一个).
   */
  stacks: number;
  /** 常驻修正: 只在来源卡位于场上时生效 (来源离场后会被删除) */
  continuous: boolean;
  expiry: Expiry | null;
  /** 条件不满足时该修正不生效 */
  condition: Condition | null;
}

/** 一条状态 (灼烧、HP 上限转移等) */
export interface StatusRecord {
  id: string;
  /** 状态标识, 同类状态按 key 归并 */
  key: string;
  name: string;
  source: string | null;
  target: string;
  /** 叠加层数 */
  stacks: number;
  /** 状态携带的效果 (已物化, 到期一并移除) */
  effects: string[];
  expiry: Expiry | null;
  data: Record<string, unknown>;
}

/** 解析目标/求值条件所需的最小上下文 */
export interface ResolveScope {
  state: BattleState;
  /** 效果控制者 (SELF / OPPONENT 的参照) */
  controller: PlayerId;
  /** 效果来源卡 */
  source: CardInstance | null;
  /** 正在结算的事件 */
  event: GameEvent | null;
  /**
   * 效果局部变量 (SET_VAR scope EFFECT).
   * 同一个对象引用会被本次效果触发的所有连锁共享 —— 子效果能读到父效果写的变量.
   */
  vars?: Record<string, number>;
  /** FOR_EACH 当前正在处理的卡 (对应 LOOP_ITEM), 循环外为 null */
  item?: Target | null;
  /** FOR_EACH 当前序号 (从 0 开始) */
  index?: number;
}

/** 日志级别 (由轻到重). 面板按级别筛选, 引擎按阈值记录 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** 全部级别, 顺序 = 由轻到重 */
export const LOG_LEVELS: readonly LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

/** 级别的显示名 (界面用) */
export const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  DEBUG: '调试',
  INFO: '信息',
  WARN: '警告',
  ERROR: '错误',
};

/** 级别的轻重 (比较记录阈值用) */
export function logLevelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/** 日志类别 */
export type LogKind = 'SYSTEM' | 'EVENT' | 'EFFECT' | 'MODIFY' | 'ZONE' | 'STATUS' | 'COMBAT';

/**
 * 各日志类别的默认级别 (写日志时可以显式覆盖).
 *
 * 事件流水 (EVENT) 默认为 DEBUG: 它是「每个时点都派发一次」的噪音.
 * 引擎**仍然会把它记下来** (面板切到「调试」就能回头看), 但默认不展示, 也不会进简报.
 */
export const LOG_KIND_LEVELS: Record<LogKind, LogLevel> = {
  SYSTEM: 'INFO',
  EVENT: 'DEBUG',
  EFFECT: 'INFO',
  MODIFY: 'INFO',
  ZONE: 'INFO',
  STATUS: 'INFO',
  COMBAT: 'INFO',
};

/**
 * `state.log` 的软上限.
 *
 * 超过后从**最旧的 DEBUG** 开始丢(不够再丢最旧的 INFO); WARN / ERROR 是「需要看一眼」的记录,
 * 永远保留. 所以低等级日志再吵也不会把内存吃满, 而真正的问题不会被挤掉.
 */
export const LOG_ENTRY_LIMIT = 2000;

/** 一条战斗日志 (给 AI 叙述用; 数值一律由引擎算出) */
export interface LogEntry {
  turn: number;
  kind: LogKind;
  level: LogLevel;
  message: string;
  detail?: Record<string, unknown>;
  /**
   * 引擎内部问题 (卡牌库缺卡 / 事件连锁过深 / 事件队列异常 …).
   *
   * 这类记录留在 `state.log` 里给面板看, 但**不会进 AI 简报** ——
   * 它们是卡牌作者或引擎自己的问题, AI 看了也做不了什么, 只会白占上下文.
   */
  engine_only?: boolean;
}

/** 一次事件 */
export interface GameEvent {
  id: string;
  timing: Timing;
  /** 事件主角: 攻击者 / 被召唤者 / 被破坏者 */
  actor: Target | null;
  /** 事件对象: 被攻击者 / 被治疗者 */
  target: Target | null;
  /** 事件来源卡 */
  source: string | null;
  /** 数值载荷 (伤害/回复值), BEFORE_* 阶段可被修改 */
  value: number;
  /** 是否已被取消 */
  canceled: boolean;
  /** 附加数据 */
  data: Record<string, unknown>;
  /** 事件发生时的回合 (整轮编号) */
  turn: number;
  /**
   * 该时点的归属方.
   *
   * 卡牌 / 某一方行动引发的时点归属那一方; 双方共同参与的时点
   * (`TURN_START` / `TURN_END`) 为 null —— 此时 `when: CONTROLLER` 不做限制,
   * 双方的效果都会触发.
   */
  turn_owner: PlayerId | null;
  /** 事件发生时的行动方 */
  active: PlayerId;
}

/** 单个玩家的战斗状态 */
/** 这一方现在就付得起的答案 (面板/AI 都能读) */
export interface AskOption {
  /** 回答时传给 `resolveAsk` 的值 */
  id: string;
  /** 显示名 (面板按钮 / AI 简报) */
  label: string;
  /** 关联的卡实例 id (面板据此高亮卡牌); 没有就为 null */
  card: string | null;
}

/**
 * 询问类型.
 *
 * - `DISCARD`  手牌超上限, 必须弃牌 (引擎自己提出来, 玩家随时可答)
 * - `CONFIRM`  某条效果发动前问一句「要发动吗」
 * - `REACTION` 反击/反制机会 (对方打过来时问一句)
 */
export type AskKind = 'DISCARD' | 'CONFIRM' | 'REACTION';

/**
 * 一条待回答的询问.
 *
 * 引擎不会因为询问而停住 —— 它只是把「需要玩家拿主意」的事记在 `state.asks` 里:
 * 面板会把它弹出来, AI 简报会把它念给模型听, 实在没人回答就按 `fallback` 自动结算
 * (见 `battle.ts` 的 `resolveAsk` / `autoResolveAsk`).
 */
export interface AskRequest {
  id: string;
  kind: AskKind;
  /** 该谁回答 */
  controller: PlayerId;
  /** 一句话说清楚要做什么 */
  title: string;
  /** 补充说明 (面板展开看) */
  detail: string;
  /** 可选项 (弃牌询问里就是当时的手牌) */
  options: AskOption[];
  /** 至少要选几个 */
  min: number;
  /** 最多能选几个 */
  max: number;
  /** 没人回答时代引擎会选谁 (展示给玩家看, 也是自动结算的依据) */
  fallback: string[];
  /** 提出询问时的回合数 */
  turn: number;
}

/** 单个玩家的战斗状态 */
export interface PlayerState {
  id: PlayerId;
  hp: number;
  hp_max: number;
  /** 当前能量 (上场卡牌要花它) */
  energy: number;
  /**
   * 当前能量上限.
   *
   * 随回合增长到封顶值 (曲线见 `BattleConfig.energy`), 每次自己行动开始时刷新;
   * 关掉能量系统时两侧都是 0, 上场不再受花费限制.
   */
  energy_max: number;
  deck: string[];
  hand: string[];
  field: string[];
  graveyard: string[];
  banished: string[];
  /** 每回合/每场计数器 */
  counters: Record<string, number>;
}

/** 完整战斗状态 (可整体序列化) */
export interface BattleState {
  version: number;
  seed: number;
  /** 回合号: 双方各行动一次算一个回合 */
  turn: number;
  /** 当前行动方 */
  active: PlayerId;
  /** 本回合第几个行动方 (0 = 先手, 1 = 后手) */
  active_index: number;
  /** 每个回合的先手方 (创建战斗时固定) */
  first_side: PlayerId;
  players: Record<PlayerId, PlayerState>;
  cards: Record<string, CardInstance>;
  effects: Record<string, EffectInstance>;
  modifiers: Record<string, Modifier>;
  statuses: Record<string, StatusRecord>;
  /** 全部战斗日志 (按发生顺序; 超过 LOG_ENTRY_LIMIT 时从最旧的 DEBUG 开始丢) */
  log: LogEntry[];
  /** 待处理事件队列 (连锁过深时排队) */
  queue: GameEvent[];
  /**
   * 待回答的询问 (弃牌 / 是否发动某条效果…).
   *
   * 引擎不阻塞: 询问只是记在这里, 由面板或 AI 回答 (`resolveAsk`),
   * 没人回答时在换边前按默认答案自动结算 (`autoResolveAsk`).
   */
  asks: AskRequest[];
  /** 事件处理深度 */
  depth: number;
  /** 全局计数器 (效果使用次数等) */
  counters: Record<string, number>;
  /**
   * 战斗级变量池 (SET_VAR scope BATTLE 写入).
   *
   * 比卡上的 flags 活得更久: 每张卡各自存一份会把快照撞大, 而这里只存一份,
   * 适合「本局已经弃过几张牌」这类整场计数; 会随 `局面` 存进聊天变量.
   */
  vars: Record<string, number>;
  finished: boolean;
  winner: PlayerId | null;
}

/**
 * 引擎上下文: 操作与效果执行时拿到的"能力接口".
 *
 * 把它定义在 types.ts 是为了避免循环依赖:
 * operations.ts / effects.ts 只依赖这个接口, 具体实现在 battle.ts.
 */
export interface EngineContext {
  state: BattleState;
  /** 正在结算的事件 */
  event: GameEvent | null;
  /** 正在结算的效果 */
  effect: EffectInstance | null;
  /** 效果来源卡 */
  source: CardInstance | null;
  /** 效果控制者 */
  controller: PlayerId;
  /**
   * 效果局部变量 (SET_VAR scope EFFECT 写入, 每次效果结算重置).
   *
   * 嵌套结算 (效果触发的事件又触发别的效果) 会各自拥有一层, 读取时逐层往外找,
   * 所以子效果能读到父效果写的值, 自己写的值又不会污染父效果.
   */
  locals: Record<string, number>;
  /** 外层效果帧 (嵌套结算时用于恢复) */
  locals_stack: Record<string, number>[];
  /** FOR_EACH 当前项 (对应 LOOP_ITEM) */
  loop_item: Target | null;
  /** FOR_EACH 当前序号 */
  loop_index: number;
  /** 循环嵌套深度 (防失控) */
  loop_depth: number;
  /** 本次效果已执行的操作数 (防失控: 超过上限就停止) */
  op_count: number;
  /** STOP 已请求: 停止本效果剩下的操作 */
  stopped: boolean;
  /** BREAK 已请求: 退出最内层循环 */
  break_requested: boolean;
  /** 取得目标卡 (不存在返回 null) */
  card(id: string): CardInstance | null;
  /**
   * 这次操作里玩家批准过的 `ask` 效果 (键 = 效果实例 id 或机读区 id).
   *
   * `null` = 没人来回答 —— 这类效果就按 `ask_default` 处理 (默认照常发动).
   * 由 `attack` / `activate` 的 `options.answers` 临时装上, 操作结束后恢复.
   */
  answers: ReadonlySet<string> | null;
  /** 按目标描述解析出目标列表 */
  resolve(spec: TargetSpec | undefined, fallback?: TargetSpec): Target[];
  /** 构造作用域 (求值条件/解析目标用) */
  makeScope(source: CardInstance | null, controller: PlayerId): ResolveScope;
  /** 推入并立即结算一个事件, 返回该事件 (可读 canceled / value) */
  emit(partial: Partial<GameEvent> & { timing: Timing }): GameEvent;
  /**
   * 写日志.
   *
   * 不传 `level` 时用该 `kind` 的默认级别 (`LOG_KIND_LEVELS`).
   * **所有等级都会记下来** —— 要不要看由面板的筛选决定 (默认筛掉 DEBUG),
   * 不再有「记录阈值」这个开关.
   */
  log(kind: LogKind, message: string, detail?: Record<string, unknown>, level?: LogLevel): void;
  /**
   * 写一条「引擎内部」日志: 面板能看到, 但不会进 AI 简报.
   *
   * 用于卡牌库缺卡 / 事件连锁过深 / 事件队列异常这类**卡牌作者或引擎自己的问题**;
   * 与操作相关的警告 (场上已满、无效的攻击目标) 用 `log`, 那些 AI 是要读的.
   */
  logInternal(kind: LogKind, message: string, detail?: Record<string, unknown>, level?: LogLevel): void;
  /**
   * 把一张卡的某个数值拆成「基础值 + 每一条修正」, 用于在面板上追溯加成来源.
   *
   * 池值 (`hp` / `shield`) 不做分层运算, 返回的 contributions 为空.
   */
  explain(card: CardInstance, stat: StatKey): StatBreakdown;
  /** 随机数 [0, 1) */
  random(): number;
  /**
   * 读一个变量: 先逐层找效果局部, 再找战斗级 vars, 都没有就是 0.
   *
   * 写变量请用 `SET_VAR` 操作, 不要直接改 `state.vars`.
   */
  readVar(name: string, scope?: VarScope): number;
  /** 写一个变量 (scope EFFECT 写当前效果帧, BATTLE 写战斗级池) */
  writeVar(name: string, value: number, scope?: VarScope): void;
  /** 按引用创建卡牌实例 (不入场) */
  createCard(ref: string, owner: PlayerId): CardInstance | null;
  /** 物化一个效果实例 (实现在 effects.ts, 通过上下文暴露以避免循环依赖) */
  createEffect(
    def: EffectDefinition,
    options: { source: string | null; controller: PlayerId; status?: string | null; index?: number },
  ): EffectInstance;
  /** 把卡移动到指定区域 */
  move(card: CardInstance, zone: Zone, options?: { slot?: number | null; reason?: string }): void;
  /** 抽牌 (牌库空时按配置轮换墓地), 返回实际抽到的张数 */
  draw(player: PlayerId, count?: number): number;
  /** 让一张场上的卡发动攻击 (受 attacked_this_turn 限制); `options.pierce` = 这次攻击无视护盾 */
  attack(attacker: CardInstance, target: Target, options?: { pierce?: boolean }): boolean;
  /**
   * 造成伤害 (返回实际伤害 = 护盾吸收掉的部分 + 生命损失的部分).
   *
   * 默认由护盾先承受, 打空后才把溢出部分算到生命上 (玩家没有护盾, 直接扣血);
   * `options.pierce` 为 true 时无视护盾, 伤害全部打在生命上, 护盾一点不掉.
   * 护盾被打空的那一刻会派发 `SHIELD_BROKEN`.
   */
  damage(target: Target, value: number, source: string | null, options?: { pierce?: boolean }): number;
  /**
   * 直接增减护盾 (正数恢复 / 负数削减), 返回实际变化量.
   *
   * 结果会被限制在 0 ~ `shield_max` 之间, 所以「恢复」永远补不满上限之外的部分;
   * 护盾因此被清零时会派发 `SHIELD_BROKEN`.
   */
  changeShield(card: CardInstance, delta: number, source: string | null): number;
  /** 回复 (返回实际回复量) */
  heal(target: Target, value: number, source: string | null): number;
  /** 破坏一张场上的卡 */
  destroy(card: CardInstance, source: string | null): boolean;
  /** 重算一张卡的当前数值 */
  recalc(card: CardInstance): void;
  /** 重算所有卡的当前数值 */
  recalcAll(): void;
}
