// 战斗与 AI 交互的数据结构定义 (zod 4)
//
// 存储位置: 聊天变量, 命名空间 `战斗` (每个对话独立)
//   `战斗.出战卡组` ← 由「卡组」面板写入 (结构定义在 卡组/schema.ts)
//   `战斗.AI`       ← 本文件: 战斗快照 + 给 AI 的简报 + 世界书条件开关
//
// 设计要点
// - 整局战斗快照存进聊天变量, 脚本随刷新 / 切聊天重载后才能续战;
// - AI 只能通过 `战斗.AI.简报` 读到「它该知道的那部分」, 完整快照不注入提示词;
// - `待决策` 是给世界书条目做条件判定用的开关:
//     {{if {{get_chat_variable::战斗.AI.待决策}}}} ... {{/if}}
//   酒馆官方宏文档明确支持这种嵌套写法, 且空串 / false / 0 / off / no 都算假值.

import { z } from 'zod';

import {
  BATTLE_CHAT_KEY,
  DECK_CHAT_KEY,
  DECK_VERSION,
  DeckStoreSchema,
  DeployedDeckSchema,
} from '../卡组/schema.ts';

export { BATTLE_CHAT_KEY };

/** AI 交互数据在 `战斗` 命名空间中的键 */
export const BATTLE_AI_KEY = 'AI';

/**
 * 数据格式版本 (升级格式时 +1).
 *
 * 2 → 3: 回合模型改了 (一个回合 = 双方各行动一次), 旧快照里的 `active_index` / `first_side`
 * 等字段缺失, 强行读上去会把回合走得乱七八糟, 所以 同步.ts 会直接丢弃版本不一致的快照.
 *
 * 3 → 3 (未变): 新增的 `回放` 字段带 prefault, 旧变量读出来就是「没有回放数据」,
 * 不会影响续战; 而一旦 +1, 正在进行的战斗会被当成旧版本直接丢掉, 得不偿失.
 */
export const BATTLE_STORE_VERSION = 3;

/**
 * 回放里的一步操作.
 *
 * 「操作」直接复用 决策.ts 认得的 op 结构 (`{do, card, target, effect, slot}`),
 * 所以回放时能原样喂回同一个执行器, 不必再维护一套「显示文本 → 操作」的翻译.
 */
export const ReplayStepSchema = z.object({
  /** 步骤序号 (从 1 开始, 只用于展示; 丢弃旧步骤后仍然连续) */
  序号: z.coerce.number().prefault(0),
  /** 发生时的回合数 */
  回合: z.coerce.number().prefault(1),
  /** 行动方 */
  方: z.enum(['PLAYER', 'ENEMY']).prefault('PLAYER'),
  /** 这一步由谁发起: 玩家操作 / AI 决策 */
  来源: z.enum(['PLAYER', 'AI']).prefault('PLAYER'),
  /**
   * AI 决策所在的消息楼层 (楼层锚点).
   *
   * 该楼层被重新生成 / 编辑 / 删除时, 战斗就回退到这一步之前;
   * 玩家操作没有楼层 (它不来自任何一条消息).
   */
  楼层: z.coerce.number().nullable().prefault(null),
  /** 决策块原文的短指纹, 用来判断楼层里装的还是不是当初那个决策 */
  指纹: z.string().prefault(''),
  /** 人类可读的说明 (面板展示 / 进简报的操作记录都来自它) */
  说明: z.string().prefault(''),
  /** 结构化操作 (按顺序执行) */
  操作: z.array(z.unknown()).prefault([]),
  /** 这些操作执行完后是否结束该方的行动 (换边) */
  结束行动: z.boolean().prefault(false),
});
export type ReplayStep = z.output<typeof ReplayStepSchema>;

/**
 * 战斗回放数据.
 *
 * 与 `局面` 的关系: `局面` 是「现在长什么样」的缓存, 这里才是「怎么走到现在」的真相.
 * 步骤变多时不会无脑丢旧的, 而是把更早的部分合并成 `起点` 快照
 * (回放时从起点接着放), 所以无论战斗多长都能回到「最早保留点」.
 */
export const BattleReplaySchema = z
  .object({
    /** 仍可逐步回退的步骤 (旧 → 新) */
    步骤: z.array(ReplayStepSchema).prefault([]),
    /** 起点快照; null 表示从开局重放 */
    起点: z.unknown().nullable().prefault(null),
    /** 起点之前已经合并掉多少步 (只用于展示) */
    已丢弃: z.coerce.number().prefault(0),
  })
  .prefault({});
export type BattleReplay = z.output<typeof BattleReplaySchema>;

/**
 * 重建一场战斗所需的最小信息.
 *
 * 引擎的 `BattleConfig` 里含函数 (`card_provider`), 不能直接序列化,
 * 所以只存卡组与参数, 读档时再用卡牌库重新构造 provider.
 */
export const BattleSetupSchema = z.object({
  /** 我方卡组 (卡牌库 id, 重复出现表示多份) */
  我方卡组: z.array(z.string()).prefault([]),
  /** 敌方卡组 */
  敌方卡组: z.array(z.string()).prefault([]),
  /** 随机种子 */
  种子: z.coerce.number().prefault(1),
  /** 我方生命上限 */
  我方生命: z.coerce.number().prefault(8000),
  /** 敌方生命上限 */
  敌方生命: z.coerce.number().prefault(8000),
  /** 场上位置数量 */
  场上上限: z.coerce.number().prefault(5),
  /** 开局抽牌数 */
  开局手牌: z.coerce.number().prefault(5),
  /** 手牌上限 (超过就要弃牌, 0 或负数 = 不限) */
  手牌上限: z.coerce.number().prefault(8),
  /** 能量开关 (关掉 = 所有卡随便上场, 适合不想算资源的角色卡) */
  能量开关: z.boolean().prefault(true),
  /** 开局 / 第 1 回合的能量 */
  起始能量: z.coerce.number().prefault(1),
  /** 每过一个回合, 能量上限增长多少 */
  能量增长: z.coerce.number().prefault(1),
  /** 能量上限 (封顶) */
  能量上限: z.coerce.number().prefault(10),
  /** 轮到自己行动时是否把能量补满 (关掉则只补「上限涨的那部分」) */
  能量补满: z.boolean().prefault(true),
  /** 先手方 */
  先手: z.enum(['PLAYER', 'ENEMY']).prefault('PLAYER'),
  /** 牌库抽空时的处理方式 */
  牌库轮换: z.enum(['GRAVEYARD', 'NONE']).prefault('GRAVEYARD'),
  /** 每方自己行动开始时抽几张牌 (0 = 只在开局发牌) */
  每回合抽牌: z.coerce.number().prefault(1),
  /** 每场最多洗几次牌 (把墓地洗回牌库); 0 = 不限 */
  洗牌上限: z.coerce.number().prefault(0),
  /** 每洗一次牌, 该方之后上场卡牌的能量消耗永久 +N (0 = 无代价) */
  洗牌惩罚: z.coerce.number().prefault(1),
  /** 守卫规则: 对手场上还有卡时, 普通攻击不能直接打对方本人 */
  守卫规则: z.boolean().prefault(true),
  /** 溢出传伤比例 (0~1): 打死一张卡后多余的伤害按此比例传给该卡的控制者 */
  溢出传伤: z.coerce.number().prefault(0.5),
  /** 回合上限 (0 = 不限); 打满后按剩余生命比例判定 */
  回合上限: z.coerce.number().prefault(30),
});
export type BattleSetup = z.output<typeof BattleSetupSchema>;

/**
 * AI 交互状态.
 *
 * `简报` 由脚本每次同步时重算:
 * - 不在战斗中时是空串 → 世界书条目渲染为空 → 完全不污染提示词;
 * - 在战斗中时只含「AI 该知道的那部分」, 由世界书条目用 {{format_chat_variable::}} 读走.
 */
export const BattleAIStoreSchema = z.object({
  版本: z.coerce.number().prefault(BATTLE_STORE_VERSION),
  /** 是否有未结束的战斗 (世界书条目的条件判定开关) */
  进行中: z.boolean().prefault(false),
  /** 当前回合数 */
  回合: z.coerce.number().prefault(1),
  /** 当前行动方 */
  行动方: z.enum(['PLAYER', 'ENEMY']).prefault('PLAYER'),
  /** 是否轮到 AI 决策 (未结束 且 行动方是 AI 且未开启双方操控) */
  待决策: z.boolean().prefault(false),
  /**
   * 双方操控开关 (仅战斗模式有意义).
   *
   * 开启后玩家可以操作两边, `待决策` 恒为 false;
   * 世界书条目会改用另一段提示词告知 AI「不要输出决策块」, 避免它把玩家操作当成自己该做的事.
   */
  用户操控双方: z.boolean().prefault(false),
  /** 给 AI 的紧凑简报 (只含 AI 该看见的信息); 非战斗中为空 */
  简报: z.string().prefault(''),
  /** 本回合已发生的操作 (玩家与 AI 都记, 旧 → 新), 会进入简报告知 AI */
  本回合操作: z.array(z.string()).prefault([]),
  /** 引擎状态快照, 仅用于续战, 不注入提示词 */
  局面: z.unknown().nullable().prefault(null),
  /** 战斗回放数据 (步骤 + 起点快照); 用于回退重演, 不注入提示词 */
  回放: BattleReplaySchema,
  /** 重建战斗所需的信息 */
  配置: BattleSetupSchema.nullable().prefault(null),
  /** 最近若干条战斗日志 (旧 → 新), 供面板展示与 AI 参考 */
  日志: z.array(z.string()).prefault([]),
  /** 上一次 AI 决策的结算结果 (面板展示用, 不注入提示词) */
  结果: z.string().prefault(''),
});
export type BattleAIStore = z.output<typeof BattleAIStoreSchema>;

/** `战斗` 命名空间的结构 (出战卡组 + AI 交互) */
export const BattleNamespaceSchema = z.object({
  出战卡组: DeployedDeckSchema,
  [BATTLE_AI_KEY]: BattleAIStoreSchema,
});
export type BattleNamespace = z.output<typeof BattleNamespaceSchema>;

/**
 * 注册到聊天变量的完整结构 (变量管理器 UI 会据此校验/展示).
 *
 * 必须整体注册: `registerVariableSchema` 对同一类型是「后者覆盖前者」,
 * 分散注册会让 `卡组` 与 `战斗` 互相覆盖.
 */
export const ChatVariableSchema = z.object({
  [DECK_CHAT_KEY]: DeckStoreSchema.prefault({ 版本: DECK_VERSION, 卡组: {}, 出战卡组: '' }),
  [BATTLE_CHAT_KEY]: BattleNamespaceSchema,
});

/** 聊天变量中 `战斗.AI` 的路径 (供 {{get_chat_variable::}} 与脚本读写使用) */
export const BATTLE_AI_PATH = `${BATTLE_CHAT_KEY}.${BATTLE_AI_KEY}`;
