// 战斗节奏 - AI 操作回放与回合结算的播放间隔
//
// 起因: AI 的一次决策、以及「双方都收手之后的回合结算」过去都是「啪」地一下结算完,
// 玩家只能看到最终局面 (谁掉了多少血、哪个技能发动了都不知道是哪一步的事).
// 现在由面板按顺序一帧帧播出来, 每一帧停多久就由这里的两档间隔决定:
//
//   操作间隔 —— AI 决策里每一个操作 (上场 / 攻击 / 发动) 各停多久
//   结算间隔 —— 回合结算里每一件事 (TURN_END 技能 / 持续伤害 / 卡牌倒下) 各停多久
//
// 0 = 不播 (那部分立刻跳到最终局面). 两档分开是因为「看 AI 打牌」和「看结算算账」
// 想要的快慢常常不一样.
//
// 与面板外观一样存在「脚本变量」(键 `战斗节奏`) 里: 换聊天、换角色都还在.

import { z } from 'zod';

/** 节奏设置在脚本变量中的键名 */
export const BATTLE_PACE_KEY = '战斗节奏';

/** 默认操作间隔 (ms) */
export const DEFAULT_ACTION_INTERVAL = 2000;
/** 默认结算间隔 (ms) */
export const DEFAULT_SETTLE_INTERVAL = 2000;
/** 间隔上限 (ms) */
export const MAX_BATTLE_INTERVAL = 10000;

/** 数值归一: 非法值回退, 并夹到 [0, MAX] 的整数 */
function normalizeInterval(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.round(Math.min(MAX_BATTLE_INTERVAL, Math.max(0, number)));
}

/** 战斗节奏设置 */
export const BattlePaceSchema = z.object({
  /** AI 每一个操作的播放间隔 (ms; 0 = 不播) */
  操作间隔: z
    .unknown()
    .optional()
    .transform(value => normalizeInterval(value, DEFAULT_ACTION_INTERVAL)),
  /** 回合结算里每一件事的播放间隔 (ms; 0 = 不播) */
  结算间隔: z
    .unknown()
    .optional()
    .transform(value => normalizeInterval(value, DEFAULT_SETTLE_INTERVAL)),
});

export type BattlePace = z.infer<typeof BattlePaceSchema>;

/** 默认节奏 */
export function defaultBattlePace(): BattlePace {
  return BattlePaceSchema.parse({});
}

/** 脚本变量是否可用 (node 测试环境下没有) */
function hasScriptVariables(): boolean {
  return typeof getVariables === 'function' && typeof getScriptId === 'function';
}

/** 内存缓存: 输入框改动时要立刻生效, 不能等落盘 */
let cache: BattlePace | null = null;

/** 设置变化时的订阅者 (面板与播放逻辑共享同一个模块实例) */
const listeners = new Set<() => void>();

/** 订阅节奏变化, 返回取消订阅的函数 */
export function onBattlePaceChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 忽略: 单个订阅者出错不影响别人 */
    }
  }
}

/** 读取战斗节奏 (读不到或结构不对时回退到默认值) */
export function loadBattlePace(): BattlePace {
  if (cache) {
    return cache;
  }
  if (!hasScriptVariables()) {
    cache = defaultBattlePace();
    return cache;
  }
  try {
    const store = getVariables({ type: 'script', script_id: getScriptId() });
    const parsed = BattlePaceSchema.safeParse(store?.[BATTLE_PACE_KEY]);
    cache = parsed.success ? parsed.data : defaultBattlePace();
  } catch {
    cache = defaultBattlePace();
  }
  return cache;
}

let persist_timer: ReturnType<typeof setTimeout> | null = null;

function persistNow(): void {
  if (!hasScriptVariables() || !cache) {
    return;
  }
  try {
    insertOrAssignVariables({ [BATTLE_PACE_KEY]: cache }, { type: 'script', script_id: getScriptId() });
  } catch (error) {
    console.warn('保存战斗节奏失败:', error);
  }
}

/** 立即落盘 (面板卸载前调用, 避免刚改的数值丢失) */
export function flushBattlePaceSave(): void {
  if (persist_timer !== null) {
    clearTimeout(persist_timer);
    persist_timer = null;
  }
  persistNow();
}

/** 保存战斗节奏: 立刻更新界面, 落盘做 250ms 防抖 (连点输入框时不必每格都写) */
export function saveBattlePace(pace: Partial<BattlePace>): BattlePace {
  cache = BattlePaceSchema.parse({ ...(cache ?? defaultBattlePace()), ...pace });
  notify();
  if (hasScriptVariables()) {
    if (persist_timer !== null) {
      clearTimeout(persist_timer);
    }
    persist_timer = setTimeout(() => {
      persist_timer = null;
      persistNow();
    }, 250);
  }
  return cache;
}

/** 恢复默认节奏 */
export function resetBattlePace(): BattlePace {
  return saveBattlePace(defaultBattlePace());
}

/** 把毫秒说成人话 (界面上的提示用) */
export function describeInterval(value: number): string {
  return value <= 0 ? '不播' : `${(value / 1000).toFixed(1)} 秒`;
}

/** 界面上的灰色小字 */
export function describeBattlePace(pace: BattlePace = loadBattlePace()): string {
  return `操作 ${describeInterval(pace.操作间隔)} · 结算 ${describeInterval(pace.结算间隔)}`;
}
