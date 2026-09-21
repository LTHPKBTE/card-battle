// 战斗回放 - 用「起点快照 + 步骤」重演出任意历史时刻的战斗
//
// 为什么能回放: 引擎的随机数由 (种子, 调用序号) 推导 (见 引擎/rng.ts), 状态又是整份可序列化的,
// 所以「同一份配置 + 同一串操作」必然复现同一场战斗 —— 不需要录像, 只需要重放.
//
// 数据流:
//
//   面板操作 / AI 决策 ──► ReplayStep (结构化操作) ──► 聊天变量 战斗.AI.回放
//                                                        │
//                    楼层被重新生成 / 编辑 / 删除 ────────┴──► 回退到该步之前, 再重放一遍
//
// 两个概念要分清:
//   局面 (store.局面) —— 「现在长什么样」的缓存, 刷新页面时用来快速续战;
//   回放 (store.回放) —— 「怎么走到现在」的真相, 回退与校验都以它为准.
//
// 纯函数, 不依赖酒馆全局, 可直接在 node 中测试.

import { attachBattleConfig, createBattle, endSide, startBattle, type BattleConfig } from '../引擎/battle.ts';
import type { BattleState, PlayerId } from '../引擎/types.ts';
import { executeOps } from './决策.ts';
import type { ReplayStep, BattleReplay } from './schema.ts';

/** 保留多少步之后开始合并更早的步骤为快照 */
export const REPLAY_STEP_LIMIT = 300;

/** 合并时保留最近多少步 (其余压进起点快照) */
export const REPLAY_KEEP_STEPS = 200;

/** 两侧玩家的固定顺序 */
const SIDES: readonly PlayerId[] = ['PLAYER', 'ENEMY'];

/** 每个玩家的区域 (算指纹用) */
const ZONES: readonly ('deck' | 'hand' | 'field' | 'graveyard' | 'banished')[] = [
  'deck',
  'hand',
  'field',
  'graveyard',
  'banished',
];

/** 深拷贝 (战斗状态是纯数据; structuredClone 在旧环境没有时退回 JSON) */
function deepClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** 短指纹 (djb2 → base36): 同一个字符串必然得到同一个结果 */
export function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// 重放
// ---------------------------------------------------------------------------

/** 重放的输入 */
export interface ReplayInput {
  /** 起点快照; 没有 (或 null) 就从开局重放 */
  起点?: unknown | null;
  /** 步骤 (旧 → 新) */
  步骤: ReplayStep[];
  /** 只重放前多少步 (省略 = 全部); 用于「回退到某一步之前」 */
  截止?: number;
}

/** 从开局建一份新状态 */
function freshState(config: BattleConfig): BattleState {
  const state = createBattle(config);
  startBattle(state);
  return state;
}

/** 把一份快照接上当前配置 (卡片提供者等) */
function restoreState(snapshot: unknown, config: BattleConfig): BattleState {
  const state = deepClone(snapshot) as BattleState;
  // 旧快照没有「战斗级变量池」: 补一个空的, 免得后面读变量时踩空
  state.vars ??= {};
  attachBattleConfig(state, config);
  return state;
}

/** 重演一步 */
export function applyStep(state: BattleState, step: ReplayStep): void {
  if (state.finished) {
    return;
  }
  executeOps(state, step.方, step.操作);
  if (step.结束行动 && !state.finished) {
    endSide(state, step.方);
  }
}

/**
 * 重放出一份战斗状态.
 *
 * 不传 `截止` 就是「放到最后」, 即当前应有的局面 —— 面板可以用它和内存/变量里的局面互相对照,
 * 不一致就说明步骤记录不全 (例如卡牌库被改过, 某个操作重放时被跳过了).
 */
export function replayBattle(config: BattleConfig, input: ReplayInput): BattleState {
  const state = input.起点 ? restoreState(input.起点, config) : freshState(config);
  const steps = input.步骤.slice(0, Math.max(0, input.截止 ?? input.步骤.length));
  for (const step of steps) {
    applyStep(state, step);
  }
  return state;
}

// ---------------------------------------------------------------------------
// 指纹与体积
// ---------------------------------------------------------------------------

/**
 * 状态指纹: 涵盖会对后续判断产生影响的所有公开信息.
 *
 * 故意不含日志 / 事件队列 —— 那些是过程记录, 不是局面本身;
 * 含随机数计数器, 因为它是复现的前提.
 */
export function fingerprintState(state: BattleState): string {
  const parts: string[] = [
    `t${state.turn}`,
    `a${state.active}`,
    `i${state.active_index}`,
    `f${state.finished ? (state.winner ?? 'DRAW') : '-'}`,
    `r${state.counters.__rng ?? 0}`,
  ];
  for (const side of SIDES) {
    const player = state.players[side];
    parts.push(`${side}:${player.hp}/${player.hp_max}`);
    for (const zone of ZONES) {
      parts.push(`${zone}=${player[zone].join(',')}`);
    }
  }
  parts.push(
    Object.keys(state.cards)
      .sort()
      .map(id => {
        const card = state.cards[id];
        return `${id}:${card.zone}:${card.controller}:${card.slot}:${card.current.atk}/${card.current.shield}/${card.current.hp}`;
      })
      .join('|'),
  );
  parts.push(`s${Object.keys(state.statuses).length} m${Object.keys(state.modifiers).length}`);
  // 战斗级变量会影响后续判断 (条件里能读), 所以也要进指纹
  const vars = state.vars ?? {};
  parts.push(
    `v${Object.keys(vars)
      .sort()
      .map(key => `${key}=${vars[key]}`)
      .join(',')}`,
  );
  return hashText(parts.join('#'));
}

/** 一段数据的 JSON 体积 (字符数; 序列化失败返回 0) */
export function jsonSize(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? '').length;
  } catch {
    return 0;
  }
}

/** 回放数据的体积明细 */
export interface ReplaySize {
  /** 步骤数组的体积 */
  步骤: number;
  /** 起点快照的体积 */
  起点: number;
  /** 合计 */
  合计: number;
  /** 单步平均体积 (没有步骤时为 0) */
  平均每步: number;
}

/** 算出回放数据占多少字符 (聊天变量会被整份保存, 这个数字直接关系到变量膨胀) */
export function replaySize(replay: BattleReplay): ReplaySize {
  const steps = jsonSize(replay.步骤);
  const origin = replay.起点 === null || replay.起点 === undefined ? 0 : jsonSize(replay.起点);
  return {
    步骤: steps,
    起点: origin,
    合计: steps + origin,
    平均每步: replay.步骤.length > 0 ? Math.round(steps / replay.步骤.length) : 0,
  };
}

// ---------------------------------------------------------------------------
// 楼层锚点
// ---------------------------------------------------------------------------

/** 找到某个楼层对应的步骤下标 (没有则返回 -1) */
export function findStepIndex(steps: ReplayStep[], message_id: number): number {
  return steps.findIndex(step => step.楼层 === message_id);
}

/**
 * 回退到某个楼层对应的步骤之前要保留多少步.
 *
 * 楼层上带决策 → 保留它之前的步骤 (这一步连同之后的一起作废);
 * 楼层上没有决策 → 返回 -1, 表示战斗不需要动.
 */
export function rewindCountFor(steps: ReplayStep[], message_id: number): number {
  const index = findStepIndex(steps, message_id);
  return index < 0 ? -1 : index;
}

/**
 * 某一步的「位置指纹」是否还和楼层里现在装的内容一致.
 *
 * 用途: 用户点了重新生成 → 楼层内容已经换成新的决策, 这时才该回退;
 * 如果内容还是当初那一个决策 (例如事件只是重复通知了一次), 就不该动它.
 */
export function stepMatchesFingerprint(step: ReplayStep, current_fingerprint: string): boolean {
  return Boolean(step.指纹) && step.指纹 === current_fingerprint;
}

/**
 * 楼层被删除后的编号平移: 被删楼层之后的所有锚点都要减一.
 *
 * 酒馆的消息 id 是数组下标, 删掉一层后面的楼层都会前移 ——
 * 不平移的话, 之后回退就会认错楼层.
 */
export function shiftAnchorsAfterDelete(steps: ReplayStep[], deleted_id: number): number {
  let shifted = 0;
  for (const step of steps) {
    if (step.楼层 !== null && step.楼层 > deleted_id) {
      step.楼层 -= 1;
      shifted += 1;
    }
  }
  return shifted;
}

// ---------------------------------------------------------------------------
// 压缩 (步骤过多时把更早的部分合并成起点快照)
// ---------------------------------------------------------------------------

/** 步骤里的序号重新编号 (丢了旧步骤后仍然连续) */
export function renumberSteps(steps: ReplayStep[], offset = 0): void {
  steps.forEach((step, index) => {
    step.序号 = offset + index + 1;
  });
}

/** 快照里的日志最多留这么多条 (与变量里的局面快照保持一致的做法) */
export const REPLAY_SNAPSHOT_LOG_LIMIT = 40;

/**
 * 步骤超过上限时, 把更早的部分压进起点快照.
 *
 * 这样战斗再长也能回到「最早保留点」, 而不会像直接截断那样丢掉回退能力;
 * 压缩必然要重放一次, 但它只在跨过上限时发生 (每 REPLAY_KEEP_STEPS 步一次), 代价可忽略.
 *
 * @returns 压缩后的回放数据; 没到上限时原样返回
 */
export function compactReplay(config: BattleConfig, replay: BattleReplay): BattleReplay {
  if (replay.步骤.length <= REPLAY_STEP_LIMIT) {
    return replay;
  }

  const drop = replay.步骤.length - REPLAY_KEEP_STEPS;
  // 起点 = 从旧起点开始, 放完被丢弃的那些步骤之后的样子
  const checkpoint = replayBattle(config, { 起点: replay.起点, 步骤: replay.步骤, 截止: drop });
  const 步骤 = replay.步骤.slice(drop);
  renumberSteps(步骤, replay.已丢弃 + drop);

  return {
    步骤,
    起点: { ...checkpoint, log: checkpoint.log.slice(-REPLAY_SNAPSHOT_LOG_LIMIT) },
    已丢弃: replay.已丢弃 + drop,
  };
}

// ---------------------------------------------------------------------------
// 校验 (重放一遍, 看和现在这份局面是否一致)
// ---------------------------------------------------------------------------

/** 回放体检报告 (战斗调试面板展示用) */
export interface ReplayReport {
  /** 还能逐步回退的步数 */
  步骤数: number;
  /** 已经被合并进起点快照的步数 */
  已丢弃: number;
  /** 是否有起点快照 (没有就是从开局重放) */
  有起点: boolean;
  /** 体积明细 */
  体积: ReplaySize;
  /** 重放出来的局面和手里这份是否一致 */
  一致: boolean;
  /** 手里这份局面的指纹 */
  指纹: string;
  /** 从回放数据重新放一遍得到的指纹 */
  重放指纹: string;
  /** 不一致时的说明 (一致时为空) */
  差异: string;
  /** 重放是否抛错了 */
  错误: string;
}

/**
 * 体检: 把回放数据重新放一遍, 与手里的局面比对.
 *
 * 不一致通常意味着「当初记下的步骤已经放不出同样的局面」——
 * 最常见的原因是卡牌库被改过 (某张卡少了 / 数值变了, 重放时那条操作就被跳过了).
 * 这种情况下回退仍然可用, 但回出来的局面会与当初不同, 所以要让用户看见.
 */
export function inspectReplay(config: BattleConfig, replay: BattleReplay, state: BattleState | null): ReplayReport {
  const size = replaySize(replay);
  const report: ReplayReport = {
    步骤数: replay.步骤.length,
    已丢弃: replay.已丢弃,
    有起点: replay.起点 !== null && replay.起点 !== undefined,
    体积: size,
    一致: false,
    指纹: state ? fingerprintState(state) : '',
    重放指纹: '',
    差异: '',
    错误: '',
  };

  if (!state) {
    report.差异 = '现在没有进行中的战斗, 无从比对';
    return report;
  }

  try {
    const replayed = replayBattle(config, { 起点: replay.起点, 步骤: replay.步骤 });
    report.重放指纹 = fingerprintState(replayed);
    report.一致 = report.重放指纹 === report.指纹;
    if (!report.一致) {
      report.差异 = '重放出来的局面与当前不符 (通常是卡牌库被改过, 某条操作重放时被跳过了)';
    }
  } catch (error) {
    report.错误 = error instanceof Error ? error.message : String(error);
    report.差异 = '重放失败, 回放数据可能已损坏';
  }

  return report;
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

/** 行动方的中文名 (只用于展示) */
const SIDE_LABELS_CN: Record<PlayerId, string> = { PLAYER: '我方', ENEMY: '敌方' };

/** 步骤的显示名 (回溯列表 / 调试面板用) */
export function describeStep(step: ReplayStep): string {
  const who = step.来源 === 'AI' ? 'AI 决策' : '玩家操作';
  const floor = step.楼层 === null ? '' : ` #${step.楼层}`;
  return `T${step.回合} ${SIDE_LABELS_CN[step.方] ?? step.方} · ${who}${floor} · ${step.说明 || '(无操作)'}`;
}

/** 回放数据的规模摘要 */
export function describeReplaySize(replay: BattleReplay): string {
  const size = replaySize(replay);
  const merged = replay.已丢弃 > 0 ? `, 已合并 ${replay.已丢弃} 步` : '';
  return `${replay.步骤.length} 步${merged} · 约 ${size.合计} 字符`;
}
