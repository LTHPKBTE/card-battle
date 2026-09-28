// 卡牌系统 - 清空数据 (「数据」面板里的「清空」一段)
//
// 可以单独勾选要清哪一块:
//   · 角色卡里的卡牌 / 卡组 —— 这张角色卡的每个对话都受影响;
//   · 当前对话的卡组 / 战斗记录 —— 只影响这一个对话.
// 清空不可撤销, 所以确定按钮要倒数 5 秒才亮.
//
// 只删本脚本自己的命名空间 (卡牌库 / 卡组 / 战斗), 同一层里别的脚本写进去的数据一律不碰 ——
// 这也是这里没有「清空整个作用域」的原因.
//
// 全局层不进这个列表: 它的数据在任何角色卡、任何对话下都能改, 误删一下就是全没了;
// 要删单个卡牌 / 卡组, 用卡牌库与卡组面板里的批量删除更稳妥.
//
// 这一层接触酒馆全局, 所以不做 node 测试 (弹窗逻辑在 共用/弹窗.ts, 是纯 DOM).

import { askDialog } from './共用/弹窗';
import { closePanelsBut } from './共用/面板';
import { deleteLayerKey } from './共用/层级';
import { clearCardLayer, hasCharacter, loadLayerLibrary } from './卡牌/data';
import { clearDeckLayer, hasChat, loadLayerDeckStore } from './卡组/data';
import { BATTLE_CHAT_KEY, DECK_CHAT_KEY } from './卡组/schema';
import { endBattleSession, isBattleRunning, resetBattleCache } from './战斗/同步';

/** 确定按钮禁用多久 (毫秒) */
export const RESET_WAIT_MS = 5000;

/** 可单独清空的区域 */
export const RESET_KEYS = ['角色卡卡牌', '角色卡卡组', '对话卡组', '对话战斗'] as const;
export type ResetKey = (typeof RESET_KEYS)[number];

/** 区域名的短称呼 (用于提示信息与确认文案) */
export const RESET_LABELS: Record<ResetKey, string> = {
  角色卡卡牌: '角色卡的卡牌',
  角色卡卡组: '角色卡的卡组',
  对话卡组: '当前对话的卡组',
  对话战斗: '当前对话的战斗记录',
};

/** 清空面板上的一行 */
export interface ResetRegion {
  key: ResetKey;
  /** 一行标题 */
  标题: string;
  /** 这一块在哪 (面板按这个分两栏摆) */
  范围: '角色卡' | '当前对话';
  /** 现在能不能清 (需要对应的数据来源可用) */
  可用: boolean;
  /** 不能清的原因 (可用时是空串) */
  原因: string;
  /** 里面现在有什么 (一句说明) */
  内容: string;
  /** 现在是不是空的 */
  空: boolean;
  /** 清掉会影响谁 */
  影响: string;
}

/** 数一下某一层里有多少卡牌 */
function countLayerCards(layer: '聊天' | '角色卡' | '全局'): number {
  try {
    return Object.keys(loadLayerLibrary(layer).卡牌).length;
  } catch {
    return 0;
  }
}

/** 数一下某一层里有多少卡组 */
function countLayerDecks(layer: '聊天' | '角色卡' | '全局'): number {
  try {
    return Object.keys(loadLayerDeckStore(layer).卡组).length;
  } catch {
    return 0;
  }
}

/** 现在有没有数据来源 (角色卡或对话) */
export function hasAnySource(): boolean {
  try {
    return hasCharacter() || hasChat();
  } catch {
    return false;
  }
}

/** 列出现在可以清的区域; 读变量失败时按空处理 (反正要删) */
export function resetRegions(): ResetRegion[] {
  const 有角色卡 = (() => {
    try {
      return hasCharacter();
    } catch {
      return false;
    }
  })();
  const 有对话 = (() => {
    try {
      return hasChat();
    } catch {
      return false;
    }
  })();

  const 角色卡卡牌 = 有角色卡 ? countLayerCards('角色卡') : 0;
  const 角色卡卡组 = 有角色卡 ? countLayerDecks('角色卡') : 0;
  const 对话卡组 = 有对话 ? countLayerDecks('聊天') : 0;
  const 战斗中 = 有对话 && isBattleRunning();

  return [
    {
      key: '角色卡卡牌',
      标题: '卡牌',
      范围: '角色卡',
      可用: 有角色卡,
      原因: '请先进入一张角色卡',
      内容: 角色卡卡牌 ? `${角色卡卡牌} 张卡牌` : '没有卡牌',
      空: 角色卡卡牌 === 0,
      影响: '这张角色卡的每个对话都会少掉这些卡',
    },
    {
      key: '角色卡卡组',
      标题: '卡组',
      范围: '角色卡',
      可用: 有角色卡,
      原因: '请先进入一张角色卡',
      内容: 角色卡卡组 ? `${角色卡卡组} 套卡组` : '没有卡组',
      空: 角色卡卡组 === 0,
      影响: '这张角色卡的每个对话都会少掉这些卡组',
    },
    {
      key: '对话卡组',
      标题: '卡组',
      范围: '当前对话',
      可用: 有对话,
      原因: '请先进入一个对话',
      内容: 对话卡组 ? `${对话卡组} 套卡组` : '没有卡组',
      空: 对话卡组 === 0,
      影响: '只影响这一个对话 (出战记录也会失去指向)',
    },
    {
      key: '对话战斗',
      标题: '战斗记录',
      范围: '当前对话',
      可用: 有对话,
      原因: '请先进入一个对话',
      内容: 战斗中 ? '有一场进行中的战斗' : '战斗记录',
      空: !战斗中,
      影响: '只影响这一个对话 (战斗会直接结束)',
    },
  ];
}

/** 组装确认弹窗的正文 */
export function resetConfirmText(keys: readonly ResetKey[]): string {
  const regions = resetRegions();
  const lines = ['此操作不可撤销, 将清空:'];
  for (const key of RESET_KEYS) {
    if (!keys.includes(key)) {
      continue;
    }
    const region = regions.find(item => item.key === key);
    lines.push(`· ${RESET_LABELS[key]}${region && !region.空 ? ` —— ${region.内容}` : ''}`);
  }
  lines.push('');
  lines.push('同一层里其他脚本写进去的数据不受影响。');
  lines.push('已打开的卡牌库 / 卡组 / 战斗面板会被关闭。');
  lines.push('确定按钮在 5 秒后才会亮起。');
  return lines.join('\n');
}

/**
 * 真的执行清空 (调用方负责先关面板).
 *
 * 先结束战斗会话再删变量: 否则下一次 `syncBattle()` 会把刚删掉的战斗快照写回变量里.
 * 卡组的出战快照与出战选择都在本脚本自己的命名空间里, 不涉及别的数据.
 */
export async function clearRegions(keys: readonly ResetKey[]): Promise<void> {
  const 有对话 = (() => {
    try {
      return hasChat();
    } catch {
      return false;
    }
  })();

  if (keys.includes('对话战斗')) {
    try {
      await endBattleSession();
    } catch {
      /* 读不到变量时忽略: 下面照样把命名空间删掉 */
    }
  }
  resetBattleCache();

  if (keys.includes('角色卡卡牌')) {
    clearCardLayer('角色卡');
  }
  if (keys.includes('角色卡卡组')) {
    clearDeckLayer('角色卡');
  }
  if (有对话 && keys.includes('对话卡组')) {
    deleteLayerKey('聊天', DECK_CHAT_KEY);
  }
  if (有对话 && keys.includes('对话战斗')) {
    deleteLayerKey('聊天', BATTLE_CHAT_KEY);
  }
}

/**
 * 完整的清空流程: 确认 (倒数 5 秒) → 关掉别的面板 → 清空.
 *
 * 顺序很关键: 面板卸载时会把编辑中的草稿落盘, 先删变量再关面板会把刚删掉的卡写回来.
 */
export async function runClear(keys: readonly ResetKey[], 标题 = '清空数据'): Promise<boolean> {
  const 选中 = RESET_KEYS.filter(key => keys.includes(key));
  if (!选中.length) {
    toastr.warning('还没有勾选要清空的区域', 标题);
    return false;
  }

  const result = await askDialog({
    标题: '清空数据',
    内容: resetConfirmText(选中),
    确认文案: '清空',
    危险: true,
    等待毫秒: RESET_WAIT_MS,
  });
  if (result.button !== 'confirm') {
    return false;
  }

  closePanelsBut('数据');
  await clearRegions(选中);
  toastr.success(`已清空: ${选中.map(key => RESET_LABELS[key]).join('、')}`, 标题);
  return true;
}
