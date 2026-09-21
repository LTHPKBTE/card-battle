// 战斗引擎 - 机读区 (machine_effect) 的 zod 校验
//
// 卡牌库的机读区在存储层是 `z.looseObject({})` (字段完全自由, 便于 YAML 录入),
// 真正的语义校验发生在这里: 校验通过后交给引擎的 EffectDefinition.
import { z } from 'zod';
import { normalizeCondition, normalizeEffect, ValueError } from './值.ts';
import type { EffectDefinition } from './types.ts';

const CompareOpSchema = z.enum(['>', '>=', '=', '<=', '<']);
const ZoneSchema = z.enum(['DECK', 'HAND', 'FIELD', 'GRAVEYARD', 'BANISHED']);
const StatKeySchema = z.enum(['atk', 'shield_max', 'shield', 'hp_max', 'hp']);
const LayerSchema = z.enum(['SET', 'ADD', 'PERCENT_ADD', 'PERCENT_MULT', 'OVERRIDE']);
const VarScopeSchema = z.enum(['EFFECT', 'BATTLE']);
const AggOpSchema = z.enum(['SUM', 'COUNT', 'MAX', 'MIN', 'AVG']);
const ValueOpSchema = z.enum([
  'ADD',
  'SUB',
  'MUL',
  'DIV',
  'MOD',
  'POW',
  'MIN',
  'MAX',
  'NEG',
  'ABS',
  'FLOOR',
  'CEIL',
  'ROUND',
]);
const SortSchema = z.enum(['ATK_DESC', 'ATK_ASC', 'SHIELD_DESC', 'SHIELD_ASC', 'HP_ASC', 'HP_DESC', 'RANDOM']);
const TimingSchema = z.enum([
  'BATTLE_START',
  /** 回合开始 (双方共同参与的时点) */
  'TURN_START',
  /** 某一方开始行动 */
  'SIDE_START',
  /** 某一方结束行动 */
  'SIDE_END',
  /** 换边 (行动方交给另一方) */
  'SIDE_CHANGE',
  /** 回合结束 = 回合结算时点 (双方共同参与) */
  'TURN_END',
  'BEFORE_ATTACK',
  'AFTER_ATTACK',
  'BEFORE_DAMAGE',
  'AFTER_DAMAGE',
  'SHIELD_BROKEN',
  'BEFORE_HEAL',
  'AFTER_HEAL',
  'BEFORE_DESTROY',
  'AFTER_DESTROY',
  'ON_SUMMON',
  'ON_LEAVE',
  'ON_DRAW',
  'ON_RECYCLE',
]);

/** 触发方式: 时点, 或 MANUAL (玩家主动发动) */
const EffectTimingSchema = z.union([TimingSchema, z.literal('MANUAL')]);

/** 卡牌筛选条件 (全部可选) */
const CardQuerySchema = z.strictObject({
  zone: ZoneSchema.optional(),
  controller: z.enum(['SELF', 'OPPONENT']).optional(),
  owner: z.enum(['SELF', 'OPPONENT']).optional(),
  series: z.string().optional(),
  type: z.string().optional(),
  name: z.string().optional(),
  rarity: z.string().optional(),
  has_status: z.string().optional(),
  exclude_self: z.boolean().optional(),
  exclude_event_target: z.boolean().optional(),
});

/** 目标查询 (筛选 + 数量 + 排序) */
const TargetQuerySchema = CardQuerySchema.extend({
  max: z.number().int().positive().optional(),
  sort: SortSchema.optional(),
});

/** 目标描述 */
const TargetSpecSchema = z.union([
  z.enum([
    'SELF',
    'CONTROLLER',
    'OPPONENT',
    'EVENT_ACTOR',
    'EVENT_TARGET',
    'EVENT_SOURCE',
    'ALL_ALLIES',
    'ALL_ENEMIES',
    'ALL_FIELD',
    'RANDOM_ALLY',
    'RANDOM_ENEMY',
    'LOOP_ITEM',
  ]),
  z.object({ id: z.string() }),
  TargetQuerySchema,
]);

/**
 * 持续时间.
 *
 * 寿命以回合为单位 (一个回合 = 双方各行动一次), 到期时点由 `tick_on` 决定.
 * `tick_owner` 已废弃: 回合不再有单一归属方, 写了也不影响任何行为 (保留只为旧卡能过校验).
 */
const DurationSpecSchema = z.strictObject({
  turns: z.number().int().positive(),
  tick_on: z.enum(['TURN_START', 'TURN_END']).optional(),
  tick_owner: z.enum(['CONTROLLER', 'OPPONENT', 'ANY']).optional(),
});

/**
 * 值表达式 (结构化写法).
 *
 * ```yaml
 * value: { op: DIV, args: [{ stat: atk, of: SELF }, 2] }   # 当前攻击力的一半
 * value: { stat: hp, of: EVENT_TARGET }
 * value: { var: count }
 * value: { agg: SUM, of: ALL_FIELD, stat: atk }
 * value: { event: value }
 * value: { turn: true }
 * value: { random: true }
 * value: { if: { ... }, then: 100, else: 0 }
 * ```
 */
const ValueExprSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.strictObject({ op: ValueOpSchema, args: z.array(NumberSpecSchema).min(1) }),
    z.strictObject({ stat: StatKeySchema, of: TargetSpecSchema.optional() }),
    z.strictObject({ var: z.string().min(1), scope: VarScopeSchema.optional() }),
    z.strictObject({ agg: AggOpSchema, of: TargetSpecSchema.optional(), stat: StatKeySchema.optional() }),
    z.strictObject({ event: z.enum(['value', 'lethal']) }),
    z.strictObject({ turn: z.literal(true) }),
    z.strictObject({ random: z.literal(true) }),
    z.strictObject({ if: ConditionSchema, then: NumberSpecSchema, else: NumberSpecSchema.optional() }),
  ]),
);

/**
 * 可写的「数值」: 常量 / 字符串公式 / 表达式对象.
 *
 * 字符串公式与表达式对象最终都会被编译成同一棵 AST (`引擎/值.ts`),
 * 校验期就完成, 引擎运行时只认 AST.
 */
const NumberSpecSchema: z.ZodType<any> = z.lazy(() =>
  z.union([z.number(), z.string(), ValueExprSchema]),
);

/** 自身查询 */
const SelfQuerySchema = z.strictObject({
  zone: ZoneSchema.optional(),
  hp_below: NumberSpecSchema.optional(),
  hp_percent_below: NumberSpecSchema.optional(),
  atk_above: NumberSpecSchema.optional(),
  turns_in_zone: NumberSpecSchema.optional(),
  has_status: z.string().optional(),
  stat: StatKeySchema.optional(),
  op: CompareOpSchema.optional(),
  value: NumberSpecSchema.optional(),
});

/** 事件查询 */
const EventQuerySchema = z.strictObject({
  value_above: NumberSpecSchema.optional(),
  value_below: NumberSpecSchema.optional(),
  lethal: z.boolean().optional(),
  target_controller: z.enum(['SELF', 'OPPONENT']).optional(),
});

/** 玩家 (血量) 查询 */
const PlayerQuerySchema = z.strictObject({
  controller: z.enum(['SELF', 'OPPONENT']).optional(),
  hp_below: NumberSpecSchema.optional(),
  hp_percent_below: NumberSpecSchema.optional(),
  stat: z.enum(['hp', 'hp_max']).optional(),
  op: CompareOpSchema.optional(),
  value: NumberSpecSchema.optional(),
});

/**
 * 对「解析出来的目标」做查询 (循环变量 / 事件目标 / 一张具体的卡).
 *
 * 与 `self` 的区别是它先把 `of` 解析成目标列表, 所以能写「先打一下, 看它还没死」这种多步决策.
 */
const TargetConditionSchema = z.strictObject({
  of: TargetSpecSchema.optional(),
  exists: z.boolean().optional(),
  zone: ZoneSchema.optional(),
  hp_below: NumberSpecSchema.optional(),
  hp_percent_below: NumberSpecSchema.optional(),
  atk_above: NumberSpecSchema.optional(),
  turns_in_zone: NumberSpecSchema.optional(),
  has_status: z.string().optional(),
  stat: StatKeySchema.optional(),
  op: CompareOpSchema.optional(),
  value: NumberSpecSchema.optional(),
  count_op: CompareOpSchema.optional(),
  count_value: NumberSpecSchema.optional(),
});

/** 条件 (递归) */
const ConditionSchema: z.ZodType<any> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ConditionSchema) }),
    z.strictObject({ any: z.array(ConditionSchema) }),
    z.strictObject({ not: ConditionSchema }),
    z.strictObject({ exists: CardQuerySchema }),
    z.strictObject({ count: CardQuerySchema, op: CompareOpSchema, value: NumberSpecSchema }),
    z.strictObject({ self: SelfQuerySchema }),
    z.strictObject({ event: EventQuerySchema }),
    z.strictObject({ player: PlayerQuerySchema }),
    z.strictObject({ flag: z.string(), op: CompareOpSchema, value: NumberSpecSchema }),
    z.strictObject({ var: z.string(), op: CompareOpSchema, value: NumberSpecSchema, scope: VarScopeSchema.optional() }),
    z.strictObject({ target: TargetConditionSchema }),
    z.strictObject({ chance: z.number().min(0).max(1) }),
  ]),
);

/** 常驻修正 */
const ModifierSpecSchema = z.strictObject({
  stat: StatKeySchema,
  layer: LayerSchema.optional(),
  value: NumberSpecSchema,
  target: TargetSpecSchema.optional(),
  duration: DurationSpecSchema.optional(),
  condition: ConditionSchema.optional(),
});

/** 操作 (递归: 效果可携带子效果, 控制流可携带子操作) */
const OperationSpecSchema: z.ZodType<any> = z.lazy(() =>
  z.strictObject({
    type: z.string(),
    target: TargetSpecSchema.optional(),
    from: TargetSpecSchema.optional(),
    to: TargetSpecSchema.optional(),
    value: NumberSpecSchema.optional(),
    stat: StatKeySchema.optional(),
    layer: LayerSchema.optional(),
    status: z.string().optional(),
    name: z.string().optional(),
    duration: DurationSpecSchema.optional(),
    card: z.string().optional(),
    zone: ZoneSchema.optional(),
    /** DAMAGE / ATTACK 专用: 无视护盾, 伤害全部打在生命上 */
    pierce: z.boolean().optional(),
    effects: z.array(EffectDefinitionSchema).optional(),
    modifiers: z.array(ModifierSpecSchema).optional(),
    cancel: z.string().optional(),
    condition: ConditionSchema.optional(),
    /** 控制流: IF 的 then/else, FOR_EACH / REPEAT 的循环体 */
    then: z.array(OperationSpecSchema).optional(),
    else: z.array(OperationSpecSchema).optional(),
    operations: z.array(OperationSpecSchema).optional(),
    break_if: ConditionSchema.optional(),
    times: NumberSpecSchema.optional(),
    max: z.number().int().nonnegative().optional(),
    /** SET_VAR / ADD_VAR */
    var: z.string().optional(),
    scope: VarScopeSchema.optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
);

/** 一条效果 */
const EffectDefinitionSchema: z.ZodType<any> = z.lazy(() =>
  z.strictObject({
    id: z.string().optional(),
    on: EffectTimingSchema.optional(),
    condition: ConditionSchema.optional(),
    priority: z.number().optional(),
    cost: z.array(OperationSpecSchema).optional(),
    operations: z.array(OperationSpecSchema).optional(),
    modifiers: z.array(ModifierSpecSchema).optional(),
    limit: z
      .strictObject({
        per: z.enum(['TURN', 'BATTLE']),
        times: z.number().int().positive(),
      })
      .optional(),
    when: z.enum(['CONTROLLER', 'OPPONENT', 'ANY']).optional(),
    by: z.enum(['SELF', 'ALLY', 'ENEMY', 'ANY']).optional(),
    zones: z.array(ZoneSchema).optional(),
    ask: z.boolean().optional(),
    ask_default: z.enum(['RUN', 'SKIP']).optional(),
  }),
);

/** 机读区: 单条效果, 或 { effects: [...] } */
const MachineEffectListSchema = z.strictObject({ effects: z.array(EffectDefinitionSchema) });

/** 校验结果 */
export interface MachineEffectParseResult {
  effects: EffectDefinition[];
  error: string | null;
}

/**
 * 把机读区内容校验为效果列表.
 *
 * 支持两种写法:
 * ```yaml
 * effects:            # 多效果
 *   - on: TURN_END
 *     operations: [...]
 * ```
 * ```yaml
 * on: TURN_END        # 单效果简写
 * operations: [...]
 * ```
 * 空对象 / null 视为"没有效果" (合法).
 */
export function parseMachineEffect(raw: unknown): MachineEffectParseResult {
  if (raw === null || raw === undefined) {
    return { effects: [], error: null };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { effects: [], error: '机读效果需要是一个键值对' };
  }
  if (Object.keys(raw).length === 0) {
    return { effects: [], error: null };
  }

  // 带 effects 键 = 多效果列表; 否则视为单条效果的简写.
  // 注意不能写成 union: 单条效果分支会把未知键 effects 直接丢掉而"校验通过".
  const is_list = 'effects' in (raw as Record<string, unknown>);
  const parsed = is_list
    ? MachineEffectListSchema.safeParse(raw)
    : EffectDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map(issue => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    });
    return { effects: [], error: issues.join('; ') };
  }

  // 最后一步: 把所有的「数值」编译成值表达式 AST (字符串公式 / 表达式对象 → 同一棵树).
  // 编译错误在这里就报给作者, 不会等到战斗结算那一刻.
  const raw_effects = is_list
    ? (parsed.data as { effects: EffectDefinition[] }).effects
    : [parsed.data as EffectDefinition];
  try {
    return {
      effects: raw_effects.map((effect, index) => normalizeEffect(effect, `effects[${index}]`)),
      error: null,
    };
  } catch (error) {
    if (error instanceof ValueError) {
      return { effects: [], error: error.message };
    }
    throw error;
  }
}

/** 校验条件 (供外部复用; 返回值里的数值已经编译成 AST) */
export function parseCondition(raw: unknown): { condition: unknown; error: string | null } {
  const parsed = ConditionSchema.safeParse(raw);
  if (!parsed.success) {
    return { condition: null, error: parsed.error.issues[0]?.message ?? '条件不合法' };
  }
  try {
    return { condition: normalizeCondition(parsed.data, 'condition'), error: null };
  } catch (error) {
    if (error instanceof ValueError) {
      return { condition: null, error: error.message };
    }
    throw error;
  }
}
