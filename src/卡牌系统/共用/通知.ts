// 通用通知 - 面板浮层之外的提示渠道
//
// 面板是独立浮层, 而触发这些事件的按钮往往在酒馆自己的界面上 (例如聊天楼层的「重新生成」).
// 那时用户根本不在我们的界面里, 面板里写再多说明也看不见, 所以必须走酒馆自带的提示渠道:
//
//   toastr —— 酒馆自带的提示条 (右上角), 不需要额外授权, 也不会往聊天记录里写东西.
//
// 另外把最近发过的通知留在内存里一份, 全局调试面板会列出来 ——
// 「到底有没有触发回退」这类问题, 看一眼就知道, 不用翻控制台.

/** 通知类型 (与 toastr 的四档一致) */
export type NotifyLevel = 'info' | 'success' | 'warning' | 'error';

export interface NotifyOptions {
  /** 标题 (toastr 的加粗行) */
  title: string;
  /** 正文, 支持换行 */
  message: string;
  /** 默认 info */
  level?: NotifyLevel;
}

/** 一条已发出的通知 (供调试面板查看) */
export interface NotifyRecord extends NotifyOptions {
  /** 发出时间 (本地时间字符串) */
  at: string;
  /** 毫秒时间戳 */
  timestamp: number;
}

/** 内存里最多留多少条通知 */
export const NOTIFY_HISTORY_LIMIT = 30;

/** 最近发出的通知 (旧 → 新) */
const history: NotifyRecord[] = [];

/** 当前时间 (测试环境下没有 Date 也照常工作) */
function now(): { at: string; timestamp: number } {
  const date = new Date();
  return {
    at: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`,
    timestamp: date.getTime(),
  };
}

/**
 * 发一条通知.
 *
 * 失败也绝不抛出 —— 通知是「附带品」, 不能因为它把战斗流程带崩.
 */
export function notify(options: NotifyOptions): NotifyRecord {
  const record: NotifyRecord = { ...options, ...now() };
  history.push(record);
  if (history.length > NOTIFY_HISTORY_LIMIT) {
    history.splice(0, history.length - NOTIFY_HISTORY_LIMIT);
  }

  const level = options.level ?? 'info';
  try {
    switch (level) {
      case 'success':
        toastr.success(options.message, options.title);
        break;
      case 'warning':
        toastr.warning(options.message, options.title);
        break;
      case 'error':
        toastr.error(options.message, options.title);
        break;
      default:
        toastr.info(options.message, options.title);
        break;
    }
  } catch (error) {
    console.warn('[卡牌系统] 提示条弹出失败:', error, options.title, options.message);
  }
  return record;
}

/** 最近发出的通知 (旧 → 新); 返回副本, 调用方改不动内部状态 */
export function notifyHistory(): NotifyRecord[] {
  return history.map(item => ({ ...item }));
}

/** 清空通知记录 (调试面板的「清空」用) */
export function clearNotifyHistory(): void {
  history.length = 0;
}
