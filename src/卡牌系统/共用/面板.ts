// 面板的关闭事件名, 以及「请求关闭面板」
//
// 面板是挂在酒馆页面上的 Vue 应用, 由入口脚本 (index.ts) 注册脚本按钮并负责挂载/卸载;
// 面板内部点「✕ 关闭」时派发一个 DOM 事件, 入口脚本收到后卸载它.
// 名字必须两处一致 (注册处 / 派发处), 所以集中在这里, 别处引用常量而不是手写字符串.
//
// `closePanelsBut` 是另一类用法: 「清空 / 恢复 / 导入」这类会改动数据源的操作, 必须先把别的
// 面板关掉 —— 卡牌库面板卸载时会把编辑中的草稿落盘, 先删数据再关面板, 会把刚删掉的卡牌 /
// 卡组原样写回来.

/** 各面板的关闭事件名 (入口脚本注册, 面板内部派发) */
export const PANEL_CLOSE_EVENTS = {
  卡牌库: 'card-library-close',
  卡组: 'card-deck-close',
  战斗: 'card-battle-close',
  调试: 'card-debug-close',
  数据: 'card-data-close',
} as const;

export type PanelName = keyof typeof PANEL_CLOSE_EVENTS;

/** 请求关闭某个面板 (入口脚本收到后卸载它) */
export function requestPanelClose(name: PanelName): void {
  window.dispatchEvent(new CustomEvent(PANEL_CLOSE_EVENTS[name]));
}

/** 关掉除 `keep` 以外的面板 (改动数据前调用, 见文件头说明) */
export function closePanelsBut(keep?: PanelName): void {
  for (const name of Object.keys(PANEL_CLOSE_EVENTS) as PanelName[]) {
    if (name === keep) {
      continue;
    }
    requestPanelClose(name);
  }
}
