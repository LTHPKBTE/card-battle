// 卡牌系统 - 数据重置 (脚本按钮「清空角色数据」)
//
// 清空范围 (不可撤销):
//   1. 角色卡变量「卡牌库」  —— 这个角色身上的全部卡牌;
//   2. 当前聊天变量「卡组」  —— 这个对话里的全部卡组与出战记录;
//   3. 当前聊天变量「战斗」  —— 这个对话里的战斗快照与 AI 简报.
//
// 为什么不是直接 `replaceVariables({}, { type: 'character' })`:
// 角色卡变量是所有脚本共用的, 整个清掉会连带删掉别的脚本写进去的数据,
// 所以这里只删卡牌系统自己的命名空间 (效果上等同于「清空当前角色的卡牌与卡组数据」).
//
// 这一层接触酒馆全局, 所以不做 node 测试 (弹窗逻辑在 共用/弹窗.ts, 是纯 DOM).

import { hasCharacter, loadLibrary } from './卡牌/data';
import { CARD_LIBRARY_KEY } from './卡牌/schema';
import { hasChat, loadDecks } from './卡组/data';
import { BATTLE_CHAT_KEY, DECK_CHAT_KEY } from './卡组/schema';
import { delayedConfirmDialog } from './共用/弹窗';
import { endBattleSession, isBattleRunning, resetBattleCache } from './战斗/同步';

/** 清空时会一并移除的聊天变量命名空间 */
const CHAT_KEYS: readonly string[] = [DECK_CHAT_KEY, BATTLE_CHAT_KEY];

/** 确定按钮禁用多久 (毫秒) */
export const RESET_WAIT_MS = 5000;

/** 即将被清空的内容 (只用于弹窗文案) */
export interface ResetSummary {
  /** 卡牌库里的卡牌张数 */
  cards: number;
  /** 当前对话里的卡组数量 */
  decks: number;
  /** 是否有进行中的战斗 */
  battle: boolean;
}

/** 统计将被清空的内容; 读变量失败时按空处理 (反正要删) */
export function summarizeReset(): ResetSummary {
  let cards = 0;
  let decks = 0;
  try {
    if (hasCharacter()) {
      cards = _.values(loadLibrary().卡牌).length;
    }
  } catch {
    cards = 0;
  }
  try {
    if (hasChat()) {
      decks = loadDecks().length;
    }
  } catch {
    decks = 0;
  }
  return { cards, decks, battle: isBattleRunning() };
}

/** 组装警告弹窗的正文 */
export function resetConfirmText(summary = summarizeReset()): string {
  const lines = ['此操作不可撤销, 将清空:'];

  if (hasCharacter()) {
    lines.push(`· 角色卡变量「${CARD_LIBRARY_KEY}」: ${summary.cards} 张卡牌`);
  } else {
    lines.push('· 角色卡变量「卡牌库」: (当前没有进入角色卡)');
  }

  if (hasChat()) {
    lines.push(`· 当前对话变量「${DECK_CHAT_KEY}」: ${summary.decks} 套卡组`);
    lines.push(`· 当前对话变量「${BATTLE_CHAT_KEY}」: ${summary.battle ? '含一场进行中的战斗' : '战斗记录'}`);
  } else {
    lines.push('· 当前对话变量「卡组」「战斗」: (当前没有进入对话)');
  }

  lines.push('');
  lines.push('其他脚本写在角色卡变量 / 聊天变量里的数据不受影响。');
  lines.push('已打开的卡牌库 / 卡组 / 战斗面板会被关闭。');
  lines.push('确定按钮在 5 秒后才会亮起。');
  return lines.join('\n');
}

/**
 * 弹警告 → 等 5 秒 → 返回是否点了确定.
 *
 * 只负责确认, 不碰数据 —— 调用方需要在确认之后、清空之前先关掉面板
 * (面板卸载时会把编辑中的草稿落盘, 顺序反了会把刚删掉的卡又写回来).
 */
export function confirmClearCardData(): Promise<boolean> {
  return delayedConfirmDialog({
    标题: '清空角色卡牌与卡组数据',
    内容: resetConfirmText(),
    确认文案: '清空数据',
    取消文案: '取消',
    等待毫秒: RESET_WAIT_MS,
  });
}

/**
 * 真正执行清空.
 *
 * 先丢掉内存里的战斗会话与卡牌提供者缓存, 再删变量 ——
 * 否则下一次 `syncBattle()` 会把刚删掉的战斗快照原样写回去.
 */
export async function clearCardSystemData(): Promise<void> {
  await endBattleSession();
  resetBattleCache();

  if (hasCharacter()) {
    updateVariablesWith(
      variables => {
        _.unset(variables, CARD_LIBRARY_KEY);
        return variables;
      },
      { type: 'character' },
    );
  }

  if (hasChat()) {
    updateVariablesWith(
      variables => {
        for (const key of CHAT_KEYS) {
          _.unset(variables, key);
        }
        return variables;
      },
      { type: 'chat' },
    );
  }
}
