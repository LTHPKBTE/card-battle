// 浮动提示 - 面板里「不占布局」的提示条
//
// 面板是一整块高度定死的板子 (内容是 flex 撑满的), 提示条要是按普通流塞进去
// (v-if 的横幅), 内容区就会被压小一圈, 卡牌跟着上下跳 —— 点一次「攻击失败」
// 整副手牌就挪一次位, 这没法接受. 所以提示一律改成浮在面板上层的浮层.
//
// 两档, 判定标准是「用户自己能不能一眼看出来」:
// - `info`: 说出来只是确认一下的事 (本轮已攻击过 / 还没轮到你 / 这一方的牌库不给看),
//   4 秒后自己消失;
// - `error`: 真出了岔子, 或者「点了没反应」这种看不出原因的 (条件不满足导致什么都没发生),
//   不自动消失, 留在那里等用户看清再手动关掉.
//
// 这个文件只管清单本身 (加 / 关 / 挤掉), 计时与渲染在面板里.

/** 提示档位 */
export type NoticeLevel = 'info' | 'error';

/** 一条提示 */
export interface Notice {
  /** 自增序号, 用作 key 与「关掉哪一条」的凭据 */
  id: number;
  level: NoticeLevel;
  text: string;
}

/** 信息类提示停留多久 (毫秒) */
export const INFO_NOTICE_MS = 4000;

/** 错误类提示不自动消失 (0 = 一直留着) */
export const ERROR_NOTICE_MS = 0;

/** 同时最多显示几条 */
export const NOTICE_LIMIT = 3;

/** 这一档提示停留多久; 0 = 不自动消失 */
export function noticeDuration(level: NoticeLevel): number {
  return level === 'error' ? ERROR_NOTICE_MS : INFO_NOTICE_MS;
}

/**
 * 加一条提示, 返回新清单 (不改原数组).
 *
 * 超过上限时**先挤掉最旧的信息类** —— 错误类是「点了没反应」的原因, 比信息类值得留;
 * 满屏都是错误时才从最旧的开始挤.
 */
export function pushNotice(list: readonly Notice[], notice: Notice): Notice[] {
  const next = [...list, notice];
  while (next.length > NOTICE_LIMIT) {
    const index = next.findIndex(item => item.level !== 'error');
    next.splice(index >= 0 ? index : 0, 1);
  }
  return next;
}

/** 关掉一条 (按 id); id 不在清单里就原样返回 */
export function dismissNotice(list: readonly Notice[], id: number): Notice[] {
  return list.filter(item => item.id !== id);
}
