// 战斗引擎 - 战斗状态、事件队列与主循环
//
// 对外 API 都是纯数据进、纯数据出:
//   createBattle(config) → BattleState
//   startBattle / playCard / attack / endSide / endTurn → 修改 state
//   drain(state) → 把队列里的事件全部处理完
//
// 事件采用「深度优先 + 深度上限」: emit() 会立刻结算该事件, 因此 BEFORE_* 事件
// 的 canceled / value 能被调用方读到; 连锁过深时改为排队, 避免栈溢出与死循环.
//
// 回合模型
// --------
// **一个回合 = 双方各行动一次**. 一回合内有 2 个「行动阶段」:
//
//   TURN_START     回合开始 (双方共用, 没有归属方)
//   SIDE_START     先手方开始行动
//     …
//   SIDE_END       先手方收手
//   SIDE_CHANGE    换边 (行动方交给后手方)
//   SIDE_START     后手方开始行动
//     …
//   SIDE_END       后手方收手
//   TURN_END       回合结束 = **回合结算时点** (回合制持续伤害写在这里)
//      ↓ 引擎紧接着流逝持续时间 (状态 / 修正的剩余回合数)
//   下一回合: TURN_START → SIDE_CHANGE → SIDE_START …
//
// 「每次换边都触发」的效果写 SIDE_CHANGE; 「只在自己这一半触发」的效果写
// SIDE_START / SIDE_END + `when: CONTROLLER`; TURN_START / TURN_END 是双方共用的时点,
// 写 `when: CONTROLLER` 也不会被拦下 (双方都会触发).

import {
  activationBlockReason,
  canActivate,
  collectTriggers,
  createEffect,
  effectLabel,
  effectName,
  effectTitle,
  isEffectActive,
  isManualEffect,
  removeEffectsBySource,
  runEffect,
} from './effects.ts';
import { nextId } from './ids.ts';
import { recalcAll, recalcCard, removeModifiersBySource } from './modifiers.ts';
import { removeStatus } from './operations.ts';
import { nextRandom } from './rng.ts';
import { cardsInZone, firstFreeSlot, resolveTargets, zoneKey } from './selectors.ts';
import { explainStat } from './溯源.ts';
import {
  LOG_ENTRY_LIMIT,
  LOG_KIND_LEVELS,
  PLAYER_IDS,
  POOL_EVENT_LIMIT,
  isPlayerTarget,
  logLevelRank,
  otherPlayer,
  type AskOption,
  type AskRequest,
  type BattleState,
  type CardDefinition,
  type CardInstance,
  type CardProvider,
  type EffectDefinition,
  type EffectTiming,
  type EngineContext,
  type GameEvent,
  type LogEntry,
  type LogKind,
  type LogLevel,
  type PlayerId,
  type PlayerState,
  type ResolveScope,
  type Target,
  type Timing,
  type Zone,
} from './types.ts';

/**
 * 战斗状态格式版本.
 *
 * 2 = 回合改成了「双方各行动一次」(多了 active_index / first_side).
 * 旧格式快照与新版不兼容, 读档时由 `同步.ts` 直接丢弃重开.
 */
export const BATTLE_VERSION = 2;

/** 事件连锁深度上限 */
const MAX_CHAIN_DEPTH = 64;

/** 区域显示名 */
const ZONE_LABEL: Record<Zone, string> = {
  DECK: '牌库',
  HAND: '手牌',
  FIELD: '场上',
  GRAVEYARD: '墓地',
  BANISHED: '除外',
};

/** 阵营显示名 */
const PLAYER_LABEL: Record<PlayerId, string> = {
  PLAYER: '我方',
  ENEMY: '敌方',
};

/** 创建战斗需要的配置 */
export interface BattleConfig {
  /** 按 id 或卡名查询卡牌定义 */
  card_provider: CardProvider;
  /** 我方卡组 (卡牌库 id 或卡名) */
  player_deck: string[];
  /** 敌方卡组 */
  enemy_deck: string[];
  /** 随机种子, 同一 seed 结果可复现 */
  seed?: number;
  /** 玩家生命上限, 默认 8000 */
  player_hp?: number;
  /** 敌方生命上限, 默认同 player_hp */
  enemy_hp?: number;
  /** 场上位置数量, 默认 5 */
  field_size?: number;
  /** 开局抽牌数, 默认 5 */
  opening_hand?: number;
  /** 先手方, 默认我方 */
  first?: PlayerId;
  /**
   * 牌库抽空时的处理方式:
   * - `'GRAVEYARD'` (默认): 把墓地洗回牌库继续抽, 派发 ON_RECYCLE
   * - `'NONE'`: 不轮换, 牌库空就抽不到
   */
  recycle?: 'GRAVEYARD' | 'NONE';
  /**
   * 每方在自己行动开始时抽几张牌 (默认 1).
   *
   * 0 = 退回「只在开局发牌」的老做法. 先手方第 1 回合不抽 (先手补偿),
   * 之后每方每次行动都抽 —— 手牌因此成为一条补给线: 想一直铺场就得拿手牌换.
   */
  draw_per_turn?: number;
  /** 每场战斗最多洗几次牌 (墓地洗回); 0 / 省略 = 不限. 用完就再也洗不动, 牌库抽空即抽不到 */
  recycle_limit?: number;
  /**
   * 每洗一次牌, 该方之后上场卡牌的能量消耗永久 +N (默认 1, 0 = 无代价).
   *
   * 洗牌 = 无限牌库, 不给代价的话「打空手牌再洗」就是无本生意;
   * 加价让它成为一次真实的选择: 现在续一波, 还是留着牌打得更便宜.
   */
  recycle_penalty?: number;
  /**
   * 守卫规则 (默认开): 对手场上还有卡时, **普通攻击**不能直接打对方本人.
   *
   * 卡面效果伤害 (机读区 `DAMAGE target: OPPONENT`) 不受此限 ——
   * 那就是「破防」的出口; 卡面写 `ignore_guard: true` 的攻击也能越过去.
   */
  guard?: boolean;
  /**
   * 溢出传伤: 攻击场上卡时, 超出其剩余生命的那部分伤害按此比例 (0~1) 传给该卡的控制者.
   *
   * 默认 0.5. 0 = 关掉. 有了它, 「清场」才有推进度条的收益,
   * 也不用非得先把对手场上的卡清干净才能碰到它本人.
   */
  splash?: number;
  /**
   * 回合上限 (默认 30).
   *
   * 打满这么多回合还没分出胜负就按「剩余生命比例」判定 (比例相同算平局).
   * 0 = 不限. 这是防止双方都不肯冒进而无限拖下去的保险丝.
   */
  turn_limit?: number;
  /** 能量曲线 (上场卡牌要花的资源); 省略 = 用 `ENERGY_DEFAULTS` */
  energy?: EnergyConfig;
  /**
   * 手牌上限 (0 / 省略 = 不限).
   *
   * 超过上限不会直接把牌丢掉 —— 引擎会在 `state.asks` 里挂一条「弃牌」询问,
   * 由面板或 AI 决定弃哪张 (见 `resolveAsk`); 没人回答则在换边前自动弃最便宜的.
   */
  hand_limit?: number;
}

/**
 * 能量配置.
 *
 * 「能量」是上场卡牌要花的通用资源. 名字取得泛, 是因为这套脚本会跟着角色卡走到
 * 各种世界观里 —— 叫什么由你定, 引擎只认数字.
 *
 * 默认曲线: 第 1 回合 1 点, 每回合 +1, 10 点封顶, 每次自己行动开始时补满.
 * 于是「一回合铺一堆小卡」与「攒一个大怪」之间必须做一次选择,
 * 而「无脑铺满场直接打脸」这个最优解就被拆掉了.
 */
export interface EnergyConfig {
  /** 关掉能量 (卡面费用不再限制上场), 默认 true = 开启 */
  enabled?: boolean;
  /** 第 1 回合的能量上限, 默认 1 */
  start?: number;
  /** 每过一个回合上限涨多少, 默认 1 */
  per_turn?: number;
  /** 上限封顶, 默认 10 */
  cap?: number;
  /** 自己行动开始时是否补满上限, 默认 true (false = 只涨新涨的那一点, 会存下来) */
  refill?: boolean;
}

/** 能量曲线的缺省值 */
export const ENERGY_DEFAULTS: Required<EnergyConfig> = {
  enabled: true,
  start: 1,
  per_turn: 1,
  cap: 10,
  refill: true,
};

/** 一场战斗里「回合怎么走」的那几条规则 (战斗开始前定死, 存进存档) */
export interface BattleRules {
  draw_per_turn: number;
  recycle_limit: number;
  recycle_penalty: number;
  guard: boolean;
  splash: number;
  turn_limit: number;
}

/** 规则的缺省值 (与 `BattleConfig` 里的说明逐条对应) */
export const RULE_DEFAULTS: BattleRules = {
  draw_per_turn: 1,
  recycle_limit: 0,
  recycle_penalty: 1,
  guard: true,
  splash: 0.5,
  turn_limit: 30,
};

function nonNegative(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : fallback;
}

/** 取一份填好默认值、且已做合法化的规则 (改配置只需要动这一处) */
export function battleRules(state: BattleState): BattleRules {
  const config = CONFIGS.get(state) ?? {};
  return {
    draw_per_turn: Math.round(nonNegative(config.draw_per_turn, RULE_DEFAULTS.draw_per_turn)),
    recycle_limit: Math.round(nonNegative(config.recycle_limit, RULE_DEFAULTS.recycle_limit)),
    recycle_penalty: Math.round(nonNegative(config.recycle_penalty, RULE_DEFAULTS.recycle_penalty)),
    // 守卫开关只认「明确写了 false」, 缺失 / 非法都算开
    guard: config.guard !== false,
    splash: Math.min(1, Math.max(0, Number.isFinite(config.splash) ? Number(config.splash) : RULE_DEFAULTS.splash)),
    turn_limit: Math.round(nonNegative(config.turn_limit, RULE_DEFAULTS.turn_limit)),
  };
}

/** 运行期配置 (不放进 BattleState, 避免污染存档; 读档后需重新 attach) */
const CONFIGS = new WeakMap<BattleState, BattleConfig>();

/** 每个状态对应一个上下文, 保证队列里的事件能被同一上下文处理 */
const CONTEXTS = new WeakMap<BattleState, EngineContext>();

/** 读档后重新绑定配置 */
export function attachBattleConfig(state: BattleState, config: BattleConfig): void {
  CONFIGS.set(state, config);
}

/** 取得状态的配置 */
export function battleConfig(state: BattleState): BattleConfig | undefined {
  return CONFIGS.get(state);
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

function emptyPlayer(id: PlayerId, hp: number): PlayerState {
  return {
    id,
    hp,
    hp_max: hp,
    energy: 0,
    energy_max: 0,
    deck: [],
    hand: [],
    field: [],
    graveyard: [],
    banished: [],
    counters: {},
    recycle_count: 0,
  };
}

/**
 * 把一份可能来自旧版本的战斗状态补齐字段.
 *
 * 引擎每加一个新键, 旧快照就少一个 —— 与其到处写判空, 不如在每个入口补一次:
 * `createContext` (所有操作的总入口) 与 `同步.ts` 读档时都会调它.
 *
 * 需要在 `attachBattleConfig` 之后调 —— 能量上限要从配置曲线算出来.
 */
export function normalizeBattleState(state: BattleState): void {
  state.vars ??= {};
  state.asks ??= [];
  for (const player of PLAYER_IDS) {
    const record = state.players?.[player];
    if (!record) {
      continue;
    }
    if (!Number.isFinite(record.energy_max)) {
      record.energy_max = energyMaxFor(state, state.turn);
    }
    if (!Number.isFinite(record.energy)) {
      record.energy = record.energy_max;
    }
    // 洗牌次数是后加的字段: 旧快照里没有, 补 0 即可 (不分版本号丢弃)
    if (!Number.isFinite(record.recycle_count)) {
      record.recycle_count = 0;
    }
  }
  for (const card of Object.values(state.cards ?? {})) {
    if (!Number.isFinite(card.energy)) {
      card.energy = 0;
    }
    card.pool_events ??= [];
    card.pool_net ??= { hp: 0, shield: 0 };
  }
}

// ---------------------------------------------------------------------------
// 能量 (上场资源)
// ---------------------------------------------------------------------------

/** 取一份填好默认值的能量配置 */
export function energyConfig(state: BattleState): Required<EnergyConfig> {
  return { ...ENERGY_DEFAULTS, ...(CONFIGS.get(state)?.energy ?? {}) };
}

/** 能量系统是否开启 (关掉后卡面费用不再限制上场) */
export function energyEnabled(state: BattleState): boolean {
  return energyConfig(state).enabled;
}

/** 某一方在指定回合的能量上限 (曲线: `start + (turn - 1) × per_turn`, 封顶 `cap`) */
export function energyMaxFor(state: BattleState, turn: number): number {
  const config = energyConfig(state);
  if (!config.enabled) {
    return 0;
  }
  const grown = config.start + Math.max(0, turn - 1) * config.per_turn;
  return Math.max(0, Math.min(config.cap, grown));
}

/**
 * 一张卡的上场消耗.
 *
 * 卡牌定义与战斗中的实例都有 `energy` 字段, 所以两边都收; 负数 / 非数值按 0 算.
 */
export function cardCost(card: { energy?: number } | null | undefined): number {
  const value = card?.energy;
  return Number.isFinite(value) && (value as number) > 0 ? Math.round(value as number) : 0;
}

/** 这一方此刻付得起这张卡的能量吗 (没开能量就是永远付得起) */
export function canPayEnergy(state: BattleState, card: CardInstance): boolean {
  if (!energyEnabled(state)) {
    return true;
  }
  const record = state.players[card.controller];
  return (Number.isFinite(record?.energy) ? record.energy : 0) >= cardCostFor(state, card);
}

/**
 * 这一方因为洗牌累积的上场加价.
 *
 * 「洗牌 = 无限牌库」必须付代价, 否则把牌打空再洗就是无本生意.
 * 关掉能量系统时没有「消耗」可言, 加价自然也是 0.
 */
export function recycleSurcharge(state: BattleState, player: PlayerId): number {
  const rules = battleRules(state);
  if (!energyEnabled(state) || rules.recycle_penalty <= 0) {
    return 0;
  }
  const count = state.players[player]?.recycle_count;
  return Math.max(0, Number.isFinite(count) ? (count as number) : 0) * rules.recycle_penalty;
}

/**
 * 这张卡**此刻**上场的真实能耗 (卡面费用 + 洗牌加价).
 *
 * 与 `cardCost` 的区别: 那个只看卡面 (卡牌定义 / 实例上快照的那个数, 不会变),
 * 面板显示价格、判断付不付得起一律用这个.
 */
export function cardCostFor(state: BattleState, card: CardInstance | null | undefined): number {
  if (!card || !energyEnabled(state)) {
    return 0;
  }
  return cardCost(card) + recycleSurcharge(state, card.controller);
}

/**
 * 把一方当前的能量刷成曲线值 (在它自己行动开始时调).
 *
 * `refill: false` 时只把上限涨的那一点补上, 余额会存下来 (适合「资源累积」类规则).
 *
 * 参数直接收 `state` 而不是上下文: 演习模式中途改「能量开关」时手上没有上下文,
 * 也要能立刻把两边的能量重算一遍.
 */
export function syncPlayerEnergy(state: BattleState, player: PlayerId): void {
  const config = energyConfig(state);
  const record = state.players[player];
  const before_max = Number.isFinite(record.energy_max) ? record.energy_max : 0;
  const energy_max = energyMaxFor(state, state.turn);
  record.energy_max = energy_max;
  if (!config.enabled) {
    record.energy = 0;
    return;
  }
  if (config.refill) {
    record.energy = energy_max;
    return;
  }
  const grown = Math.max(0, energy_max - before_max);
  record.energy = Math.min(energy_max, (Number.isFinite(record.energy) ? record.energy : 0) + grown);
}

/** 把卡放入区域 (不触发事件, 仅调整数据结构) */
function placeCard(state: BattleState, card: CardInstance, zone: Zone, slot: number | null): void {
  const player = state.players[card.controller];
  const old = player[zoneKey(card.zone)];
  const index = old.indexOf(card.id);
  if (index >= 0) {
    old.splice(index, 1);
  }

  card.zone = zone;
  card.slot = zone === 'FIELD' ? (slot ?? firstFreeSlot(state, card.controller)) : null;
  card.zone_since_turn = state.turn;
  player[zoneKey(zone)].push(card.id);
}

/** 创建一个卡牌实例 (尚未入区, 也不物化效果) */
function buildInstance(state: BattleState, def: CardDefinition, owner: PlayerId): CardInstance {
  const card: CardInstance = {
    id: nextId(state, 'c'),
    card_id: def.id,
    name: def.name,
    series: def.series,
    rarity: def.rarity,
    stars: def.stars,
    type: def.type,
    attribute: def.attribute,
    gender: def.gender,
    race: def.race,
    height: def.height,
    owner,
    controller: owner,
    zone: 'DECK',
    slot: null,
    base: { atk: def.atk, shield: def.shield, hp: def.hp },
    energy: cardCost(def),
    current: {
      atk: def.atk,
      shield_max: def.shield,
      shield: def.shield,
      hp_max: def.hp,
      hp: def.hp,
    },
    effects: [],
    statuses: [],
    flags: {},
    zone_since_turn: 0,
    attacked_this_turn: false,
    pool_events: [],
    pool_net: { hp: 0, shield: 0 },
  };
  state.cards[card.id] = card;
  return card;
}

/** 洗牌 (用引擎随机数, 保证可复现) */
function shuffle(state: BattleState, ids: string[]): void {
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextRandom(state) * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
}

/**
 * 创建一场战斗 (含开局抽牌, 但不派发事件; 事件由 startBattle 派发).
 *
 * 卡组里查不到的卡会被跳过并记入日志, 不会中断创建.
 */
export function createBattle(config: BattleConfig): BattleState {
  const first_side = config.first ?? 'PLAYER';
  const state: BattleState = {
    version: BATTLE_VERSION,
    seed: config.seed ?? 1,
    turn: 1,
    active: first_side,
    active_index: 0,
    first_side,
    players: {
      PLAYER: emptyPlayer('PLAYER', config.player_hp ?? 8000),
      ENEMY: emptyPlayer('ENEMY', config.enemy_hp ?? config.player_hp ?? 8000),
    },
    cards: {},
    effects: {},
    modifiers: {},
    statuses: {},
    log: [],
    queue: [],
    depth: 0,
    counters: {},
    vars: {},
    asks: [],
    finished: false,
    winner: null,
  };
  CONFIGS.set(state, config);

  const ctx = getContext(state);
  for (const player of PLAYER_IDS) {
    const deck = player === 'PLAYER' ? config.player_deck : config.enemy_deck;
    for (const ref of deck) {
      ctx.createCard(ref, player);
    }
    shuffle(state, state.players[player].deck);
  }

  const opening = config.opening_hand ?? 5;
  for (const player of PLAYER_IDS) {
    for (let i = 0; i < opening; i += 1) {
      const top = cardsInZone(state, player, 'DECK')[0];
      if (!top) {
        break;
      }
      placeCard(state, top, 'HAND', null);
    }
  }

  ctx.log('SYSTEM', `战斗开始 (种子 ${state.seed})`);
  return state;
}

/** 派发战斗开始、回合开始与先手方的行动开始 */
export function startBattle(state: BattleState): void {
  const ctx = getContext(state);
  // 开局就超了手牌上限 (开局手牌 > 上限) 也得问一次
  for (const player of PLAYER_IDS) {
    syncHandLimit(ctx, player);
  }
  ctx.emit({
    timing: 'BATTLE_START',
    actor: state.first_side,
    turn_owner: null,
    data: { first_side: state.first_side },
  });
  ctx.emit({ timing: 'TURN_START', actor: state.active, turn_owner: null, data: { turn: state.turn } });
  tickExpiries(ctx, 'TURN_START');
  beginSide(ctx, state.active, 0);
  drain(state);
}

/**
 * 写一条日志 (全部等级都记, 面板负责筛选).
 *
 * `engine_only` = 引擎内部问题, 不进 AI 简报 (见 `EngineContext.logInternal`).
 */
function pushLog(
  state: BattleState,
  kind: LogKind,
  message: string,
  detail: Record<string, unknown> | undefined,
  level: LogLevel,
  engine_only: boolean,
): LogEntry {
  const entry: LogEntry = {
    turn: state.turn,
    kind,
    level,
    message,
    ...(detail ? { detail } : {}),
    ...(engine_only ? { engine_only: true } : {}),
  };
  state.log.push(entry);
  trimLog(state);
  return entry;
}

/**
 * 控制 `state.log` 的体积: 超过上限就从最旧的开始丢.
 *
 * DEBUG (事件流水) 最先丢, 然后是最旧的 INFO; WARN / ERROR 永远保留 ——
 * 否则一场长局下来「真正要看的那几行」反而被事件流水挤出去了.
 */
function trimLog(state: BattleState): void {
  if (state.log.length <= LOG_ENTRY_LIMIT) {
    return;
  }
  const serious = state.log.filter(entry => logLevelRank(entry.level) >= logLevelRank('WARN')).length;
  let budget = Math.max(0, LOG_ENTRY_LIMIT - serious);
  const kept: LogEntry[] = []; // 新 → 旧
  for (let index = state.log.length - 1; index >= 0; index -= 1) {
    const entry = state.log[index];
    if (logLevelRank(entry.level) >= logLevelRank('WARN')) {
      kept.push(entry);
      continue;
    }
    if (budget > 0) {
      kept.push(entry);
      budget -= 1;
    }
  }
  state.log = kept.reverse();
}

// ---------------------------------------------------------------------------
// 上下文
// ---------------------------------------------------------------------------

function createContext(state: BattleState): EngineContext {
  // 旧快照可能缺字段 (引擎每加一个新键就少一个), 在这里补一次, 后面整场都不用判空
  normalizeBattleState(state);
  const ctx: EngineContext = {
    state,
    event: null,
    effect: null,
    source: null,
    controller: state.active,
    answers: null,
    locals: Object.create(null) as Record<string, number>,
    locals_stack: [],
    loop_item: null,
    loop_index: 0,
    loop_depth: 0,
    op_count: 0,
    stopped: false,
    break_requested: false,

    card(id) {
      return state.cards[id] ?? null;
    },

    resolve(spec, fallback) {
      return resolveTargets(ctx.makeScope(ctx.source, ctx.controller), spec, fallback);
    },

    makeScope(source, controller): ResolveScope {
      return {
        state,
        controller,
        source,
        event: ctx.event,
        vars: ctx.locals,
        item: ctx.loop_item,
        index: ctx.loop_index,
      };
    },

    readVar(name, scope) {
      if (scope !== 'BATTLE') {
        const local = ctx.locals[name];
        if (typeof local === 'number') {
          return local;
        }
      }
      return state.vars?.[name] ?? 0;
    },

    writeVar(name, value, scope) {
      if (scope === 'BATTLE') {
        state.vars[name] = value;
        return;
      }
      ctx.locals[name] = value;
    },

    emit(partial) {
      return emitEvent(ctx, partial);
    },

    log(kind, message, detail, level) {
      const entry = pushLog(state, kind, message, detail, level ?? LOG_KIND_LEVELS[kind], false);
      ctx.onFrame?.(entry);
    },

    logInternal(kind, message, detail, level) {
      const entry = pushLog(state, kind, message, detail, level ?? LOG_KIND_LEVELS[kind], true);
      ctx.onFrame?.(entry);
    },

    explain(card, stat) {
      return explainStat(state, card, stat, source =>
        ctx.makeScope(source, source?.controller ?? card.controller),
      );
    },

    random() {
      return nextRandom(state);
    },

    createCard(ref, owner) {
      const config = CONFIGS.get(state);
      const def = config?.card_provider(ref) ?? null;
      if (!def) {
        ctx.logInternal('SYSTEM', `卡牌库中找不到「${ref}」`, { ref }, 'WARN');
        return null;
      }
      const card = buildInstance(state, def, owner);
      state.players[owner].deck.push(card.id);
      materializeCardEffects(ctx, card, def);
      return card;
    },

    createEffect(def, options) {
      return createEffect(ctx, def, options);
    },

    move(card, zone, options) {
      moveCard(ctx, card, zone, options?.slot ?? null, options?.reason);
    },

    draw(player, count = 1) {
      return drawFor(ctx, player, count);
    },

    attack(attacker, target, options) {
      return performAttack(ctx, attacker, target, options);
    },

    damage(target, value, source, options) {
      return dealDamage(ctx, target, value, source, options);
    },

    changeShield(card, delta, source) {
      return changeShield(ctx, card, delta, source);
    },

    heal(target, value, source) {
      return healTarget(ctx, target, value, source);
    },

    destroy(card, source) {
      return destroyCard(ctx, card, source);
    },

    recalc(card) {
      recalcCard(state, card, source => ctx.makeScope(source, source?.controller ?? state.active));
    },

    recalcAll() {
      recalcAll(state, source => ctx.makeScope(source, source?.controller ?? state.active));
    },
  };

  return ctx;
}

/** 取得 (或创建) 状态的上下文 */
export function getContext(state: BattleState): EngineContext {
  let ctx = CONTEXTS.get(state);
  if (!ctx) {
    ctx = createContext(state);
    CONTEXTS.set(state, ctx);
  }
  return ctx;
}

/** 物化一张卡自身携带的效果 */
function materializeCardEffects(ctx: EngineContext, card: CardInstance, def: CardDefinition): void {
  def.effects.forEach((effect: EffectDefinition, index: number) => {
    const instance = createEffect(ctx, effect, { source: card.id, controller: card.controller, index });
    card.effects.push(instance.id);
  });
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

function emitEvent(ctx: EngineContext, partial: Partial<GameEvent> & { timing: Timing }): GameEvent {
  const state = ctx.state;
  const event: GameEvent = {
    id: nextId(state, 'ev'),
    timing: partial.timing,
    actor: partial.actor ?? null,
    target: partial.target ?? null,
    source: partial.source ?? null,
    value: partial.value ?? 0,
    canceled: false,
    data: partial.data ?? {},
    turn: state.turn,
    // 双方共同参与的时点 (TURN_START / TURN_END) 显式传 null, 其余默认归属当前行动方
    turn_owner: 'turn_owner' in partial ? (partial.turn_owner ?? null) : state.active,
    active: state.active,
  };

  if (state.depth >= MAX_CHAIN_DEPTH) {
    state.queue.push(event);
    ctx.logInternal('SYSTEM', '事件连锁过深, 已延后处理', { timing: event.timing }, 'WARN');
    return event;
  }

  state.depth += 1;
  try {
    processEvent(ctx, event);
  } finally {
    state.depth -= 1;
  }
  return event;
}

/** 结算一个事件: 收集该时点的效果并依次发动 */
function processEvent(ctx: EngineContext, event: GameEvent): void {
  const previous_event = ctx.event;
  const previous_effect = ctx.effect;
  const previous_source = ctx.source;
  const previous_controller = ctx.controller;

  ctx.event = event;
  ctx.log(
    'EVENT',
    `时点 ${event.timing}`,
    { value: event.value, actor: event.actor, owner: event.turn_owner },
    'DEBUG',
  );

  try {
    const triggers = collectTriggers(ctx, event);
    for (const instance of triggers) {
      if (ctx.state.finished) {
        return;
      }
      ctx.effect = instance;
      ctx.source = instance.source ? (ctx.state.cards[instance.source] ?? null) : null;
      ctx.controller = instance.controller;
      try {
        runEffect(ctx, instance);
      } finally {
        ctx.effect = previous_effect;
        ctx.source = previous_source;
        ctx.controller = previous_controller;
      }
    }
  } finally {
    ctx.event = previous_event;
  }
}

/** 把队列中剩余事件处理完 (顶层操作结束后调用) */
export function drain(state: BattleState): void {
  const ctx = getContext(state);
  let guard = 0;
  while (state.queue.length > 0) {
    guard += 1;
    if (guard > 1024) {
      ctx.logInternal('SYSTEM', '事件队列异常, 已清空', { queue: state.queue.length }, 'ERROR');
      state.queue.length = 0;
      break;
    }
    const event = state.queue.shift();
    if (event) {
      processEvent(ctx, event);
    }
  }
}

// ---------------------------------------------------------------------------
// 基础动作
// ---------------------------------------------------------------------------

function moveCard(ctx: EngineContext, card: CardInstance, zone: Zone, slot: number | null, reason?: string): void {
  const was_field = card.zone === 'FIELD';
  const was_hand = card.zone === 'HAND';

  // 场上容量限制: 进场 (而非换位) 时若已满则拒绝
  if (zone === 'FIELD' && !was_field) {
    const size = CONFIGS.get(ctx.state)?.field_size ?? 5;
    if (cardsInZone(ctx.state, card.controller, 'FIELD').length >= size) {
      ctx.log('SYSTEM', `${PLAYER_LABEL[card.controller]}的场上已满, ${card.name} 无法上场`, { card: card.id }, 'WARN');
      return;
    }
  }

  placeCard(ctx.state, card, zone, slot);

  if (was_field) {
    ctx.emit({ timing: 'ON_LEAVE', actor: card.id, source: card.id });
    // 卡牌离场后, 它自己产生的常驻效果与修正失效 (状态带来的不受影响)
    removeEffectsBySource(ctx, card.id);
    removeModifiersBySource(ctx.state, card.id);
    // 池值流水与常驻修正同寿: 离场就清掉, 免得旧数据跟到墓地/手牌里
    card.pool_events.length = 0;
    card.pool_net = { hp: 0, shield: 0 };
    ctx.recalcAll();
  }
  if (zone === 'FIELD') {
    ctx.emit({ timing: 'ON_SUMMON', actor: card.id, source: card.id });
    // 常驻修正在卡进入场上后才生效
    ctx.recalcAll();
  }

  ctx.log('ZONE', `${card.name} 进入${ZONE_LABEL[zone]}${reason ? ` (${reason})` : ''}`);

  // 手牌数量一变就同步「弃牌」询问 (超过上限就挂一条, 回到上限以内就撤掉)
  if (was_hand || zone === 'HAND') {
    syncHandLimit(ctx, card.controller);
  }
}

function checkDefeat(ctx: EngineContext, player: PlayerId): void {
  const state = ctx.state;
  if (state.players[player].hp > 0 || state.finished) {
    return;
  }
  state.finished = true;
  state.winner = otherPlayer(player);
  ctx.log('SYSTEM', `${PLAYER_LABEL[player]}被击败, ${PLAYER_LABEL[state.winner]}获胜`);
}

/**
 * 记一条池值变动流水 (面板上的「池值变动」用它回答「这个数怎么来的」).
 *
 * 池值没有「基础值 + 修正」的结构, 所以能追溯的不是来源而是流水:
 * 谁、在哪个回合、把它加/减了多少. 只留最近 `POOL_EVENT_LIMIT` 条,
 * 净变化另外累在 `pool_net` 上 —— 流水被截断之后它仍然是准的.
 *
 * `source` 由调用方给 (攻击者是攻击的那张卡, 效果是效果的来源卡),
 * 不能拿 `ctx.source` 代替: 普通攻击根本没有「当前效果」.
 */
function recordPool(
  ctx: EngineContext,
  card: CardInstance,
  stat: 'hp' | 'shield',
  delta: number,
  harm: boolean,
  source: string | null,
): void {
  if (delta === 0) {
    return;
  }
  card.pool_events ??= [];
  card.pool_net ??= { hp: 0, shield: 0 };
  card.pool_events.push({
    turn: ctx.state.turn,
    stat,
    delta,
    source,
    // ctx.effect 只在「正在结算某条效果」时有值, 普通攻击就是 null;
    // 只记机读区写了 id 的技能名 (没写的会被叫成「效果 1」, 贴在流水上只会更花)
    label: ctx.effect && ctx.effect.def.id === ctx.effect.label ? ctx.effect.label : null,
    harm,
  });
  if (card.pool_events.length > POOL_EVENT_LIMIT) {
    card.pool_events.splice(0, card.pool_events.length - POOL_EVENT_LIMIT);
  }
  card.pool_net[stat] += delta;
}

/**
 * 护盾增减的统一入口 (正数恢复 / 负数削减).
 *
 * - 结果钳制在 `0 ~ shield_max` 之间
 * - `overflow` 只在「被打空时把溢出到生命的伤害一并告诉效果」时使用, 非伤害来源传 0
 * - 从「有护盾」掉到 0 的那一刻派发 `SHIELD_BROKEN`, 此时卡还在场上、溢出伤害还没结算
 * - 返回实际变化量 (带符号), 所以恢复可能小于请求值、削减可能被剩余护盾卡住
 */
function applyShieldChange(
  ctx: EngineContext,
  card: CardInstance,
  delta: number,
  source: string | null,
  overflow: number,
): number {
  if (delta === 0 || card.zone !== 'FIELD') {
    return 0;
  }
  const before = card.current.shield;
  const after = Math.max(0, Math.min(card.current.shield_max, before + delta));
  const actual = after - before;
  if (actual === 0) {
    return 0;
  }
  card.current.shield = after;
  recordPool(ctx, card, 'shield', actual, delta < 0, source);
  ctx.log('COMBAT', `${card.name} 的护盾${actual > 0 ? '+' : '-'}${Math.abs(actual)} (当前 ${after})`, { source });
  // 护盾是池值: 变化后立刻重算 (写「护盾低于上限 xx%」这类条件的修正当场就能跟上)
  ctx.recalcAll();

  if (before > 0 && after <= 0) {
    ctx.emit({
      timing: 'SHIELD_BROKEN',
      actor: card.id,
      target: card.id,
      source,
      value: -actual,
      data: { attacker: source, overflow: Math.max(0, overflow) },
    });
  }
  return actual;
}

/** 直接增减护盾 (RESTORE_SHIELD / CLEAR_SHIELD 等操作走这里) */
function changeShield(ctx: EngineContext, card: CardInstance, delta: number, source: string | null): number {
  return applyShieldChange(ctx, card, delta, source, 0);
}

/**
 * 造成伤害 (返回实际伤害 = 护盾吃掉的部分 + 生命损失的部分).
 *
 * 结算顺序是「护盾 → 生命」: 护盾先把伤害吃下来, 打空后才把溢出部分算到生命上;
 * `options.pierce` 为 true 时直接跳过护盾 (护盾一点不掉). 玩家没有护盾, 直接扣血。
 *
 * 打在卡上时, 超出这张卡剩余生命的那部分 (也就是「打过头的」伤害) 会按
 * `BattleConfig.splash` 的比例传给这张卡的控制者 —— 见 `splashToOwner`.
 */
function dealDamage(
  ctx: EngineContext,
  target: Target,
  value: number,
  source: string | null,
  options?: { pierce?: boolean },
): number {
  if (value <= 0) {
    return 0;
  }
  const state = ctx.state;

  if (isPlayerTarget(target)) {
    return damagePlayer(ctx, target, value);
  }

  const card = state.cards[target];
  if (!card || card.zone !== 'FIELD') {
    return 0;
  }
  const owner = card.controller;

  let remaining = value;
  let absorbed = 0;
  if (!options?.pierce && card.current.shield > 0) {
    absorbed = -applyShieldChange(ctx, card, -remaining, source, value); // change ≤ 0 → 取正
    remaining -= absorbed;
  }
  if (card.zone !== 'FIELD') {
    // 破盾时被效果移走/破坏了, 溢出伤害落空
    return absorbed;
  }

  const hp_lost = Math.min(remaining, card.current.hp);
  card.current.hp -= hp_lost;
  recordPool(ctx, card, 'hp', -hp_lost, true, source);
  ctx.log('COMBAT', `${card.name} 受到 ${hp_lost} 点伤害 (剩余生命 ${card.current.hp})`, { source });
  // 生命是池值: 变化后立刻重算 (见 dealDamage 顶部的说明)
  ctx.recalcAll();

  if (card.current.hp <= 0) {
    destroyCard(ctx, card, source);
  }
  // 打过头的部分按比例拍给这张卡的控制者 (卡已经倒下也算 —— 清场的收益就在这里)
  splashToOwner(ctx, owner, remaining - hp_lost);
  return absorbed + hp_lost;
}

/** 给玩家造成伤害 (护盾之类与玩家无关); 返回实际扣掉的生命 */
function damagePlayer(ctx: EngineContext, player: PlayerId, value: number): number {
  if (value <= 0) {
    return 0;
  }
  const record = ctx.state.players[player];
  const actual = Math.min(value, record.hp);
  record.hp -= actual;
  ctx.log('COMBAT', `${PLAYER_LABEL[player]}受到 ${actual} 点伤害 (剩余 ${record.hp})`);
  // 生命是池值: 变化后立刻重算, 「生命低于 xx」类判定不用等到回合结算
  ctx.recalcAll();
  checkDefeat(ctx, player);
  return actual;
}

/**
 * 溢出传伤: 把「打死一张卡之后还剩下的那份伤害」按 `BattleConfig.splash` 的比例传给它的控制者.
 *
 * 比例是 0~1 (默认 0.5); 结果四舍五入, 算出来是 0 就不记日志 (免得刷屏).
 */
function splashToOwner(ctx: EngineContext, owner: PlayerId, overflow: number): void {
  if (overflow <= 0) {
    return;
  }
  const rate = battleRules(ctx.state).splash;
  const splash = Math.round(overflow * rate);
  if (splash <= 0) {
    return;
  }
  ctx.log('COMBAT', `溢出伤害的 ${Math.round(rate * 100)}% 传给了${PLAYER_LABEL[owner]} (${splash} 点)`, {
    player: owner,
    overflow,
  });
  damagePlayer(ctx, owner, splash);
}

function healTarget(ctx: EngineContext, target: Target, value: number, source: string | null): number {
  if (value <= 0) {
    return 0;
  }
  const state = ctx.state;

  if (isPlayerTarget(target)) {
    const player = state.players[target];
    const actual = Math.min(value, player.hp_max - player.hp);
    player.hp += actual;
    ctx.log('COMBAT', `${PLAYER_LABEL[target]}回复 ${actual} 点生命 (剩余 ${player.hp})`);
    ctx.recalcAll();
    return actual;
  }

  const card = state.cards[target];
  if (!card || card.zone !== 'FIELD') {
    return 0;
  }
  const actual = Math.min(value, card.current.hp_max - card.current.hp);
  card.current.hp += actual;
  recordPool(ctx, card, 'hp', actual, false, source);
  ctx.log('COMBAT', `${card.name} 回复 ${actual} 点生命 (剩余 ${card.current.hp})`, { source });
  ctx.recalcAll();
  return actual;
}

function destroyCard(ctx: EngineContext, card: CardInstance, source: string | null): boolean {
  if (card.zone !== 'FIELD') {
    return false;
  }
  const before = ctx.emit({ timing: 'BEFORE_DESTROY', actor: card.id, source });
  if (before.canceled) {
    ctx.log('COMBAT', `${card.name} 的破坏被阻止`);
    return false;
  }
  moveCard(ctx, card, 'GRAVEYARD', null, 'destroy');
  ctx.emit({ timing: 'AFTER_DESTROY', actor: card.id, source });
  return true;
}

// ---------------------------------------------------------------------------
// 询问 (引擎提问 / 面板与 AI 回答)
//
// 「需要玩家拿主意」的事分两类, 分别走两条路:
//   ① 引擎自己就能结算的 (弃牌): 挂进 state.asks, 面板/AI 随时回答, 不回答也能自动收尾;
//   ② 发生在**下一次攻击 / 发动里**的 (机读区的 `ask: true`): 面板先问, 把选择作为
//      `answers` 传进 `attack` / `activate` —— 这样时机不会错, 也能记进回放步骤.
// ---------------------------------------------------------------------------

/** 提出一条询问 (id 自动分配) */
export function addAsk(
  state: BattleState,
  input: Omit<AskRequest, 'id' | 'turn'> & { turn?: number },
): AskRequest {
  state.asks ??= [];
  const ask: AskRequest = { id: nextId(state, 'a'), turn: input.turn ?? state.turn, ...input };
  state.asks.push(ask);
  return ask;
}

/** 列出待回答的询问 (可按回答方筛) */
export function listAsks(state: BattleState, controller?: PlayerId): AskRequest[] {
  return (state.asks ?? []).filter(ask => !controller || ask.controller === controller);
}

/** 找一条询问 (不存在返回 null) */
export function findAsk(state: BattleState, id: string): AskRequest | null {
  return (state.asks ?? []).find(ask => ask.id === id) ?? null;
}

/** 撤掉一条询问 (不结算) */
export function removeAsk(state: BattleState, id: string): boolean {
  const index = (state.asks ?? []).findIndex(ask => ask.id === id);
  if (index < 0) {
    return false;
  }
  state.asks.splice(index, 1);
  return true;
}

/**
 * 没人回答时弃哪几张 (确定性策略: 先弃最便宜, 再看数值最小, 最后按 id 排).
 *
 * 单拎成函数是为了让面板能提前告诉玩家「不回答会弃掉这几张」,
 * 展示与自动结算用同一份结果, 不会出现「说一套做一套」.
 */
function discardPolicy(state: BattleState, player: PlayerId, count: number): string[] {
  const weight = (card: CardInstance) => card.current.atk + card.current.shield_max + card.current.hp_max;
  return cardsInZone(state, player, 'HAND')
    .slice()
    .sort(
      (a, b) =>
        cardCostFor(state, a) - cardCostFor(state, b) ||
        weight(a) - weight(b) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, Math.max(0, count))
    .map(card => card.id);
}

/**
 * 手牌上限的自动同步.
 *
 * 超过上限就补一条「弃牌」询问, 回到上限以内就把它撤掉 —— 询问不必被「回答」:
 * 玩家直接把牌打出去也算解决 (打出去本身就不超了).
 *
 * 手牌数量一变 (`moveCard`) 就会调一次, 所以不需要在别处手动维护.
 */
function syncHandLimit(ctx: EngineContext, player: PlayerId): void {
  const state = ctx.state;
  const limit = Math.max(0, Math.round(CONFIGS.get(state)?.hand_limit ?? 0));
  const hand = cardsInZone(state, player, 'HAND');
  const over = limit > 0 ? hand.length - limit : 0;
  const existing = (state.asks ?? []).find(ask => ask.kind === 'DISCARD' && ask.controller === player);

  if (over <= 0) {
    if (existing) {
      removeAsk(state, existing.id);
    }
    return;
  }

  const options: AskOption[] = hand.map(card => ({
    id: card.id,
    label: `${card.name} (${cardCostFor(state, card)} 能量)`,
    card: card.id,
  }));
  const fallback = discardPolicy(state, player, over);
  const detail =
    `${PLAYER_LABEL[player]}的手牌 ${hand.length} 张, 上限 ${limit} 张 —— ` +
    `至少要弃掉 ${over} 张 (弃牌进墓地); 想清手牌的话可以多弃几张, 最多弃到一张不剩.\n` +
    `不回答的话, 会在换边时自动弃掉: ${fallback
      .map(id => state.cards[id]?.name ?? id)
      .join('、')}`;

  if (existing) {
    existing.options = options;
    existing.min = over;
    existing.max = hand.length;
    existing.fallback = fallback;
    existing.title = `手牌超过上限 (${hand.length}/${limit}), 至少弃掉 ${over} 张`;
    existing.detail = detail;
    return;
  }

  addAsk(state, {
    kind: 'DISCARD',
    controller: player,
    title: `手牌超过上限 (${hand.length}/${limit}), 至少弃掉 ${over} 张`,
    detail,
    options,
    min: over,
    max: hand.length,
    fallback,
  });
  ctx.log('ZONE', `${PLAYER_LABEL[player]}的手牌 ${hand.length} 张, 超过上限 ${limit} —— 等待弃牌选择`, {
    player,
  });
}

/** 把一条询问的答案真的执行掉 (目前只有弃牌需要引擎自己动手) */
function applyAskAnswer(ctx: EngineContext, ask: AskRequest, picked: readonly string[]): void {
  const state = ctx.state;
  if (ask.kind !== 'DISCARD') {
    // CONFIRM / REACTION 的「批准」由调用方通过答案清单执行 (面板会在同一个操作里把答案传回去),
    // 引擎在这里只负责把询问摘掉并记一笔
    ctx.log('SYSTEM', `${PLAYER_LABEL[ask.controller]}回答了「${ask.title}」: ${picked.join(', ') || '(无)'}`);
    return;
  }
  const names: string[] = [];
  for (const id of picked) {
    const card = state.cards[id];
    if (card && card.zone === 'HAND') {
      names.push(card.name);
      moveCard(ctx, card, 'GRAVEYARD', null, '弃牌');
    }
  }
  ctx.log('ZONE', `${PLAYER_LABEL[ask.controller]}弃掉了 ${names.join('、') || '(无)'}`);
}

/**
 * 回答一条询问.
 *
 * `answer` 的取值: 弃牌 / 确认 都是选项 id (弃牌就是卡实例 id, 确认就是效果实例 id).
 * 答案不合法 (数量不对 / 卡已不在手里 / 询问不存在) 时什么都不做并返回 false ——
 * 面板与 AI 都可能拿出过期的答案, 这里必须挡掉.
 */
export function resolveAsk(state: BattleState, ask_id: string, answer: readonly string[]): boolean {
  const ctx = getContext(state);
  const ask = findAsk(state, ask_id);
  if (!ask) {
    return false;
  }
  const picked = [...new Set(answer.map(String))];
  if (picked.length < Math.max(0, ask.min) || (ask.max > 0 && picked.length > ask.max)) {
    ctx.log('SYSTEM', `回答「${ask.title}」的数量不对 (需要 ${ask.min}~${ask.max} 项), 已忽略`, {}, 'WARN');
    return false;
  }
  if (ask.kind === 'DISCARD') {
    const hand = new Set(cardsInZone(state, ask.controller, 'HAND').map(card => card.id));
    if (!picked.every(id => hand.has(id))) {
      ctx.log('SYSTEM', '弃牌里选了不在手牌里的卡, 这次回答被忽略', { ask: ask.id }, 'WARN');
      return false;
    }
  }

  removeAsk(state, ask.id);
  applyAskAnswer(ctx, ask, picked);
  // 手牌变少后可能已经不超上限了; 还超就重新挂一条 (数量跟着手牌走)
  syncHandLimit(ctx, ask.controller);
  drain(state);
  return true;
}

/** 按默认答案自动结算一条询问 (没人回答时的收尾) */
export function autoResolveAsk(state: BattleState, ask_id: string): boolean {
  const ask = findAsk(state, ask_id);
  if (!ask) {
    return false;
  }
  const answer = ask.kind === 'DISCARD' ? discardPolicy(state, ask.controller, ask.min) : ask.fallback;
  if (!resolveAsk(state, ask.id, answer)) {
    // 默认答案也不合法时直接摘掉, 免得永远卡着
    removeAsk(state, ask.id);
    return false;
  }
  return true;
}

/** 把某一方的询问全部按默认答案结算 (换边前调) */
export function autoResolveAsks(state: BattleState, controller?: PlayerId): void {
  for (const ask of listAsks(state, controller)) {
    autoResolveAsk(state, ask.id);
  }
}

/** 一条「发动前会问玩家」的效果 (面板据此生成确认框) */
export interface AskableEffect {
  /** 来源卡实例 id */
  card_id: string;
  /** 效果实例 id (也是 answer 里要填的值) */
  effect_id: string;
  /** 机读区里写的 id */
  def_id: string;
  /** 显示名, 如「钢铁壁垒 · 反击」 */
  label: string;
  /** 触发时点 */
  timing: EffectTiming;
  /** 没人回答时是否默认发动 (对应机读区的 `ask_default`, 缺省 true) */
  default_run: boolean;
}

/**
 * 列出「接下来会问玩家要不要发动」的效果 (`ask: true`).
 *
 * 面板在攻击 / 发动前调它, 把清单做成勾选框; 玩家的选择再作为 `answers` 传回去.
 * 这里只粗筛「来源卡在不在场上 + 时点对不对」, 不预演条件 ——
 * 条件不满足的会被引擎自己滤掉, 不会造成错误结算.
 */
export function listAskable(
  state: BattleState,
  player: PlayerId,
  timings: readonly EffectTiming[],
): AskableEffect[] {
  const ctx = getContext(state);
  const result: AskableEffect[] = [];
  for (const instance of Object.values(state.effects)) {
    const on = instance.def.on;
    if (!instance.def.ask || !on || instance.controller !== player || !timings.includes(on)) {
      continue;
    }
    if (!isEffectActive(ctx, instance)) {
      continue;
    }
    result.push({
      card_id: instance.source ?? '',
      effect_id: instance.id,
      def_id: instance.def.id ?? '',
      label: effectLabel(ctx, instance),
      timing: on,
      default_run: (instance.def.ask_default ?? 'RUN') === 'RUN',
    });
  }
  return result;
}

/** 一次玩家操作可以带上的「答案清单」 */
export interface ActionOptions {
  /**
   * 这次操作里批准发动的 `ask` 效果 (效果实例 id 或机读区 id).
   *
   * 省略 = 没人回答, 这类效果按 `ask_default` 处理;
   * 传空数组 = 「问过了, 一个都不发动」.
   *
   * 面板在攻击前用 `listAskable` 生成清单, 玩家的选择就填在这里;
   * 它会跟着回放步骤一起存下去, 所以重演出来的局面仍然一致.
   */
  answers?: readonly string[];
  /**
   * 每写一条日志回调一次 (面板用它把这次操作拆成一帧帧播出来, 见 `战斗/播放.ts`).
   *
   * 引擎只负责喊, 不管帧: 调用方拿到回调后自己决定留不留 (通常是记一份状态快照).
   */
  onFrame?: (entry: LogEntry) => void;
}

/** 在「带一份答案清单」的情况下跑一段操作, 结束后恢复上一个清单 */
function withAnswers<T>(ctx: EngineContext, answers: readonly string[] | undefined, run: () => T): T {
  if (answers === undefined) {
    return run();
  }
  const before = ctx.answers;
  ctx.answers = new Set(answers.map(String));
  try {
    return run();
  } finally {
    ctx.answers = before;
  }
}

/**
 * 在「开着播放帧钩子」的情况下跑一段操作, 结束后摘掉 (上下文是跟着状态缓存的,
 * 不摘掉的话下一次调用还在往里写帧).
 *
 * 钩子是可以嵌套的: 外层已经装好时, 内层不再传 `onFrame` 就不该把它顶掉 ——
 * 否则「先攻击, 再收手」这种一次调用里, 前半段的帧就丢了.
 */
export function withFrameHook<T>(
  state: BattleState,
  onFrame: ((entry: LogEntry) => void) | undefined,
  run: () => T,
): T {
  if (!onFrame) {
    return run();
  }
  const ctx = getContext(state);
  const previous = ctx.onFrame;
  ctx.onFrame = onFrame;
  try {
    return run();
  } finally {
    ctx.onFrame = previous;
  }
}

// ---------------------------------------------------------------------------
// 玩家操作
// ---------------------------------------------------------------------------

/** 这张卡现在能否从手牌上场 (场上未满 + 能量付得起) */
export function canPlayCard(state: BattleState, card_id: string): boolean {
  const card = state.cards[card_id];
  if (!card || card.zone !== 'HAND' || state.finished) {
    return false;
  }
  const size = CONFIGS.get(state)?.field_size ?? 5;
  if (cardsInZone(state, card.controller, 'FIELD').length >= size) {
    return false;
  }
  return canPayEnergy(state, card);
}

/** 从手牌把卡召唤到场上 (扣能量) */
export function playCard(state: BattleState, card_id: string, slot?: number): boolean {
  if (!canPlayCard(state, card_id)) {
    return false;
  }
  const ctx = getContext(state);
  const card = state.cards[card_id];
  const record = state.players[card.controller];
  const cost = cardCostFor(state, card);
  if (cost > 0) {
    record.energy -= cost;
    ctx.log('SYSTEM', `支付 ${cost} 点能量上场「${card.name}」(剩余 ${record.energy}/${record.energy_max})`);
  }
  moveCard(ctx, card, 'FIELD', slot ?? null, 'play');
  if (card.zone !== 'FIELD' && cost > 0) {
    // 没进场 (比如中途场上被判满) 就把能量退回去
    record.energy += cost;
  }
  drain(state);
  return card.zone === 'FIELD';
}

/**
 * 这张卡现在能否被自由移动到指定区域.
 *
 * 供演习模式 (看牌库 → 直接上场 / 场上卡收回牌库) 使用: 只检查卡是否存在、
 * 区域是否变化、场上是否已满, **不检查回合归属与攻击次数**.
 */
export function canMoveCardTo(state: BattleState, card_id: string, zone: Zone): boolean {
  const card = state.cards[card_id];
  if (!card || state.finished || card.zone === zone) {
    return false;
  }
  if (zone === 'FIELD') {
    const size = CONFIGS.get(state)?.field_size ?? 5;
    return cardsInZone(state, card.controller, 'FIELD').length < size;
  }
  return true;
}

/**
 * 把一张卡移动到指定区域 (自由操作, 不检查回合归属).
 *
 * 走的是和正式操作同一条 moveCard 路径, 因此 ON_SUMMON / ON_LEAVE 等事件、
 * 常驻修正的失效与重算都会正常发生.
 */
export function moveCardTo(state: BattleState, card_id: string, zone: Zone, slot?: number | null): boolean {
  if (!canMoveCardTo(state, card_id, zone)) {
    return false;
  }
  const ctx = getContext(state);
  const card = state.cards[card_id];
  moveCard(ctx, card, zone, slot ?? null, 'free');
  drain(state);
  return card.zone === zone;
}

/**
 * 牌库抽空时把墓地洗回牌库 (默认行为, 可用 config.recycle = 'NONE' 关闭).
 *
 * ON_RECYCLE 在洗牌之前派发, 这样「在墓地里才生效」的效果能捕捉到这次轮换.
 *
 * 洗牌不是白洗的: 每洗一次, 该方之后上场的卡都贵 `config.recycle_penalty` 点
 * (见 `cardCostFor`), 而且最多只能洗 `config.recycle_limit` 次 (0 = 不限).
 */
function recycleDeck(ctx: EngineContext, player: PlayerId): boolean {
  const state = ctx.state;
  if ((CONFIGS.get(state)?.recycle ?? 'GRAVEYARD') === 'NONE') {
    return false;
  }
  const record = state.players[player];
  const rules = battleRules(state);
  if (rules.recycle_limit > 0 && record.recycle_count >= rules.recycle_limit) {
    ctx.log('SYSTEM', `${PLAYER_LABEL[player]}的洗牌次数已用完 (上限 ${rules.recycle_limit} 次), 牌库抽空就抽不到牌`);
    return false;
  }
  const ids = record.graveyard.slice();
  if (ids.length === 0) {
    return false;
  }

  // 先记账再洗: 加了价之后本场不会再恢复, 日志里也能顺手把累计加价说清楚
  record.recycle_count += 1;
  const surcharge = recycleSurcharge(state, player);
  const price = surcharge > 0 ? `; 本场上场消耗累计 +${surcharge}` : '';
  const quota = rules.recycle_limit > 0 ? ` (第 ${record.recycle_count}/${rules.recycle_limit} 次)` : '';
  ctx.log('SYSTEM', `${PLAYER_LABEL[player]}的牌库已空, 墓地 ${ids.length} 张牌洗回牌库${quota}${price}`);
  ctx.emit({ timing: 'ON_RECYCLE', actor: player, source: null, value: ids.length, data: { player } });

  // 洗牌过程中可能已被效果移走, 逐个确认仍在墓地
  for (const id of ids) {
    const card = state.cards[id];
    if (card && card.zone === 'GRAVEYARD') {
      placeCard(state, card, 'DECK', null);
    }
  }
  shuffle(state, state.players[player].deck);
  return true;
}

/** 抽牌 (牌库空时按配置轮换墓地) */
function drawFor(ctx: EngineContext, player: PlayerId, count: number): number {
  const state = ctx.state;
  let drawn = 0;
  for (let i = 0; i < count; i += 1) {
    let top = cardsInZone(state, player, 'DECK')[0];
    if (!top) {
      if (!recycleDeck(ctx, player)) {
        break;
      }
      top = cardsInZone(state, player, 'DECK')[0];
      if (!top) {
        break;
      }
    }
    moveCard(ctx, top, 'HAND', null, 'draw');
    ctx.emit({ timing: 'ON_DRAW', actor: top.id, source: top.id });
    drawn += 1;
  }
  if (drawn > 0) {
    ctx.log('ZONE', `${PLAYER_LABEL[player]}抽了 ${drawn} 张牌`);
  }
  return drawn;
}

/** 抽牌 (对外 API) */
export function drawCards(state: BattleState, player: PlayerId, count = 1): number {
  const ctx = getContext(state);
  const drawn = drawFor(ctx, player, count);
  drain(state);
  return drawn;
}

/** 这张卡现在能否攻击 */
export function canAttack(state: BattleState, attacker_id: string): boolean {
  const attacker = state.cards[attacker_id];
  return Boolean(
    attacker && attacker.zone === 'FIELD' && !attacker.attacked_this_turn && !state.finished,
  );
}

/** 攻击目标是否合法: 对手场上的卡, 或对手本人 (后者要过守卫规则) */
function isValidAttackTarget(
  ctx: EngineContext,
  attacker: CardInstance,
  target: Target,
  options?: { ignore_guard?: boolean },
): boolean {
  if (isPlayerTarget(target)) {
    if (target !== otherPlayer(attacker.controller)) {
      return false;
    }
    return !isGuardBlocked(ctx.state, attacker, target, options);
  }
  const card = ctx.state.cards[target];
  return Boolean(card && card.zone === 'FIELD' && card.controller !== attacker.controller);
}

/**
 * 这一击是不是被守卫规则挡下了 (对手场上还有卡, 却想直接打脸).
 *
 * 单拎出来是为了让面板 / 决策层能给出「为什么打不了」的准确说法,
 * 而不是笼统的「目标不合法」.
 */
export function isGuardBlocked(
  state: BattleState,
  attacker: CardInstance,
  target: Target,
  options?: { ignore_guard?: boolean },
): boolean {
  if (!isPlayerTarget(target) || target === attacker.controller || options?.ignore_guard) {
    return false;
  }
  return battleRules(state).guard && cardsInZone(state, target, 'FIELD').length > 0;
}

/**
 * 攻击: 结算 BEFORE_ATTACK → BEFORE_DAMAGE → 伤害 → AFTER_DAMAGE → AFTER_ATTACK.
 *
 * 任意一步被取消都会中断后续步骤 (陷阱卡正是靠 BEFORE_DAMAGE 的 CANCEL 生效).
 * 攻击宣言一旦通过就会消耗本回合的攻击机会, 即使伤害被取消.
 * 打脸 (目标是玩家) 还要过守卫规则, 见 `isGuardBlocked`.
 * 不负责 drain, 由调用方 (对外 API / 顶层操作) 统一收尾.
 */
function performAttack(
  ctx: EngineContext,
  attacker: CardInstance | null,
  target: Target,
  options?: { pierce?: boolean; ignore_guard?: boolean },
): boolean {
  const state = ctx.state;
  if (state.finished) {
    return false;
  }
  if (!attacker || attacker.zone !== 'FIELD' || attacker.attacked_this_turn) {
    return false;
  }
  if (!isValidAttackTarget(ctx, attacker, target, options)) {
    const reason = isGuardBlocked(state, attacker, target, options)
      ? `${PLAYER_LABEL[target as PlayerId]}场上还有卡, 普通攻击只能打场上的卡 (除非效果写明无视守卫)`
      : `无效的攻击目标: ${attacker.name} → ${target}`;
    ctx.log('SYSTEM', reason, { attacker: attacker.id, target }, 'WARN');
    return false;
  }

  const before_attack = ctx.emit({
    timing: 'BEFORE_ATTACK',
    actor: attacker.id,
    target,
    source: attacker.id,
  });
  if (before_attack.canceled) {
    return false;
  }

  attacker.attacked_this_turn = true;

  const before_damage = ctx.emit({
    timing: 'BEFORE_DAMAGE',
    actor: attacker.id,
    target,
    source: attacker.id,
    value: attacker.current.atk,
  });
  if (before_damage.canceled) {
    return false;
  }

  // 允许效果在 BEFORE_DAMAGE 里把伤害改到别的目标上
  const final_target = before_damage.target ?? target;
  const dealt = dealDamage(ctx, final_target, before_damage.value, attacker.id, options);
  ctx.emit({ timing: 'AFTER_DAMAGE', actor: attacker.id, target: final_target, source: attacker.id, value: dealt });
  ctx.emit({ timing: 'AFTER_ATTACK', actor: attacker.id, target: final_target, source: attacker.id, value: dealt });
  return true;
}

/** 攻击 (对外 API); `options.answers` 是这次攻击里批准发动的 `ask` 效果 */
export function attack(
  state: BattleState,
  attacker_id: string,
  target: Target,
  options?: { pierce?: boolean; ignore_guard?: boolean } & ActionOptions,
): boolean {
  const ctx = getContext(state);
  return withAnswers(ctx, options?.answers, () => {
    const result = performAttack(ctx, state.cards[attacker_id] ?? null, target, options);
    drain(state);
    return result;
  });
}

/** 一个可主动发动的效果 (供界面 / AI 选择) */
export interface ActivatableEffect {
  /** 来源卡实例 id */
  card_id: string;
  /** 效果实例 id (传给 activate) */
  effect_id: string;
  /** 效果定义的 id */
  def_id: string;
  /** 显示名 */
  label: string;
}

/** 列出某方此刻可以主动发动的效果 */
export function listActivatable(state: BattleState, player: PlayerId = state.active): ActivatableEffect[] {
  const ctx = getContext(state);
  const result: ActivatableEffect[] = [];
  for (const instance of Object.values(state.effects)) {
    if (!isManualEffect(instance) || instance.controller !== player) {
      continue;
    }
    if (!canActivate(ctx, instance)) {
      continue;
    }
    result.push({
      card_id: instance.source ?? '',
      effect_id: instance.id,
      def_id: instance.def.id ?? '',
      label: effectLabel(ctx, instance),
    });
  }
  return result;
}

/**
 * 主动发动一个效果.
 *
 * `effect_id` 可以是效果实例 id (来自 listActivatable), 也可以是机读区里写的 `id`.
 * 返回是否成功发动 (代价付不出 / 次数用尽 / 条件不满足都返回 false).
 *
 * `options.answers` 是这次发动里批准触发的 `ask` 效果 (面板先问, 再把选择传回来).
 */
export function activate(
  state: BattleState,
  card_id: string,
  effect_id: string,
  options?: ActionOptions,
): boolean {
  const ctx = getContext(state);
  const card = state.cards[card_id];
  if (!card || state.finished) {
    return false;
  }
  const instance =
    state.effects[effect_id] ??
    card.effects
      .map(id => state.effects[id])
      .find(item => Boolean(item) && item.def.id === effect_id) ??
    null;
  if (!instance || instance.source !== card_id || !isManualEffect(instance)) {
    return false;
  }
  return withAnswers(ctx, options?.answers, () => {
    const ok = runEffect(ctx, instance);
    if (!ok) {
      // 发动失败不写日志的话, 「次数用完了」与「条件不满足」都看不出区别 —— 玩家只会觉得按钮/技能没反应
      const reason = activationBlockReason(ctx, instance);
      if (reason) {
        ctx.log('EFFECT', `${effectTitle(ctx, instance)} 这次没有发动 (${reason})`, {
          effect: instance.def.id ?? '',
          card: instance.source ?? '',
          label: effectName(ctx, instance) ?? '',
        });
      }
    }
    drain(state);
    return ok;
  });
}

/**
 * 让某一方开始行动: 恢复该方场上的攻击次数, 补能量, 抽牌, 派发 SIDE_START.
 *
 * 攻击次数的重置放在「该方自己行动开始时」, 所以两边各能攻击一次,
 * 而不是要等整个回合结算完.
 *
 * 顺序是有意的: 补能量 → 抽牌 → SIDE_START.
 * 抽到的牌当回合就能上场, ON_DRAW 之类的效果也能在本方行动里立刻生效.
 * 唯一的例外是**第 1 回合的先手方不抽** —— 不然先手等于白多一张牌 (先手补偿).
 */
function beginSide(ctx: EngineContext, side: PlayerId, side_index: number): void {
  const state = ctx.state;
  for (const id of state.players[side].field) {
    const card = state.cards[id];
    if (card) {
      card.attacked_this_turn = false;
    }
  }
  state.players[side].counters = {};
  syncPlayerEnergy(state, side);

  const draw = state.turn === 1 && side_index === 0 ? 0 : battleRules(state).draw_per_turn;
  if (draw > 0) {
    drawFor(ctx, side, draw);
  }

  const record = state.players[side];
  const parts: string[] = [];
  if (energyEnabled(state)) {
    parts.push(`能量 ${record.energy}/${record.energy_max}`);
  }
  if (draw > 0) {
    parts.push(`抽 ${draw} 张`);
  }
  const tail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  ctx.log('SYSTEM', `第 ${state.turn} 回合 · ${PLAYER_LABEL[side]}行动开始${tail}`, { side, side_index });
  ctx.emit({ timing: 'SIDE_START', actor: side, value: side_index, data: { side_index } });
}

/**
 * 结束某一方的行动 (默认当前行动方).
 *
 * - 本回合第 1 个行动方收手 → 换边 (SIDE_CHANGE) 后让另一方行动
 * - 第 2 个行动方收手 → 进入**回合结算** (见 settleRound)
 *
 * 返回是否真的结束了这次行动 (不是该方行动 / 战斗已结束都是 false).
 */
export function endSide(state: BattleState, side: PlayerId = state.active, options?: ActionOptions): boolean {
  const ctx = getContext(state);
  return withFrameHook(state, options?.onFrame, () =>
    withAnswers(ctx, options?.answers, () => endSideInner(ctx, state, side)),
  );
}

/** `endSide` 的主体 (答案清单已经在外面装好了) */
function endSideInner(ctx: EngineContext, state: BattleState, side: PlayerId): boolean {
  if (state.finished || side !== state.active) {
    drain(state);
    return false;
  }
  // 待回答的询问不能跨过换边: 还没人回答的就按默认答案结算 (弃最便宜的)
  if (listAsks(state, side).length > 0) {
    ctx.log('SYSTEM', `${PLAYER_LABEL[side]}还有 ${listAsks(state, side).length} 项待回答, 先按默认答案结算`, {}, 'WARN');
    autoResolveAsks(state, side);
  }
  const index = state.active_index;
  ctx.emit({ timing: 'SIDE_END', actor: side, value: index, data: { side_index: index } });
  if (state.finished) {
    drain(state);
    return false;
  }

  if (index === 0) {
    const next = otherPlayer(side);
    state.active = next;
    state.active_index = 1;
    ctx.emit({ timing: 'SIDE_CHANGE', actor: next, data: { from: side, side_index: 1 } });
    beginSide(ctx, next, 1);
  } else {
    settleRound(ctx, side);
  }
  drain(state);
  return true;
}

/**
 * 回合结算: 双方都行动完之后进入.
 *
 * 顺序: `TURN_END` (回合制持续伤害写在这里) → 流逝持续时间 (状态 / 修正) →
 * 重置攻击次数与计数器 → 推进回合号 → `TURN_START` → 换边 → 新回合先手方 `SIDE_START`.
 */
function settleRound(ctx: EngineContext, ending: PlayerId): void {
  const state = ctx.state;
  // 回合结算前把两边的待回答询问收掉 (否则它们会跨回合一直挂着)
  autoResolveAsks(state);
  ctx.log('SYSTEM', `回合 ${state.turn} 结算 (双方行动完毕)`, { turn: state.turn, ended_by: ending });
  ctx.emit({
    timing: 'TURN_END',
    actor: null,
    turn_owner: null,
    data: { turn: state.turn, ended_by: ending },
  });
  if (state.finished) {
    return;
  }
  tickExpiries(ctx, 'TURN_END');

  for (const card of Object.values(state.cards)) {
    card.attacked_this_turn = false;
  }
  for (const player of PLAYER_IDS) {
    state.players[player].counters = {};
  }

  state.turn += 1;
  // 回合上限: 打满就按剩余生命比例收场, 免得双方都不肯冒进时无限拖下去
  const limit = battleRules(state).turn_limit;
  if (limit > 0 && state.turn > limit) {
    finishByTurnLimit(ctx, limit);
    return;
  }
  state.active = state.first_side;
  state.active_index = 0;
  ctx.emit({ timing: 'TURN_START', actor: state.active, turn_owner: null, data: { turn: state.turn } });
  tickExpiries(ctx, 'TURN_START');
  // 后手方交棒给下一回合的先手方 —— 这也是一次「换边」
  ctx.emit({ timing: 'SIDE_CHANGE', actor: state.active, data: { from: ending, side_index: 0 } });
  beginSide(ctx, state.active, 0);
}

/**
 * 回合上限到了: 按「剩余生命比例」判定胜负.
 *
 * 用比例而不是绝对值, 因为双方生命上限可以分别设置.
 * 比例一样就是平局 (`winner` 为 null, 但战斗确实结束了).
 */
function finishByTurnLimit(ctx: EngineContext, limit: number): void {
  const state = ctx.state;
  const ratio = (player: PlayerId) => {
    const record = state.players[player];
    return record.hp_max > 0 ? record.hp / record.hp_max : 0;
  };
  const mine = ratio('PLAYER');
  const theirs = ratio('ENEMY');
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  state.finished = true;
  state.winner = mine === theirs ? null : mine > theirs ? 'PLAYER' : 'ENEMY';
  const verdict = state.winner ? `${PLAYER_LABEL[state.winner]}获胜` : '双方平局';
  ctx.log(
    'SYSTEM',
    `已达回合上限 ${limit}, 按剩余生命比例判定: 我方 ${percent(mine)} / 敌方 ${percent(theirs)} —— ${verdict}`,
    { turn_limit: limit },
  );
}

/**
 * 结束整个回合: 把本回合还没行动的双方都结束掉, 直接进入下一回合.
 *
 * 只想结束当前行动方 (换边给对手) 用 `endSide`.
 */
export function endTurn(state: BattleState, options?: ActionOptions): void {
  const turn_before = state.turn;
  endSide(state, state.active, options);
  if (!state.finished && state.turn === turn_before) {
    endSide(state, state.active, options);
  }
}

/**
 * 流逝持续时间: 剩余回合归零的修正 / 状态被移除.
 *
 * 寿命以**回合**为单位 —— 每次调用把该时点上的所有期限减 1, 不再区分归属.
 */
function tickExpiries(ctx: EngineContext, timing: 'TURN_START' | 'TURN_END'): void {
  const state = ctx.state;

  for (const modifier of Object.values(state.modifiers)) {
    const expiry = modifier.expiry;
    if (!expiry || expiry.tick_on !== timing) {
      continue;
    }
    expiry.remaining -= 1;
    if (expiry.remaining <= 0) {
      delete state.modifiers[modifier.id];
    }
  }

  for (const status of Object.values(state.statuses)) {
    const expiry = status.expiry;
    if (!expiry || expiry.tick_on !== timing) {
      continue;
    }
    expiry.remaining -= 1;
    if (expiry.remaining <= 0) {
      const card = state.cards[status.target];
      ctx.log('STATUS', `${card?.name ?? '卡牌'} 的「${status.name}」结束`);
      removeStatus(ctx, status);
    }
  }

  ctx.recalcAll();
}
