// 面板外观 - 半透明垫底 + 高斯模糊
//
// 三个面板 (卡牌库 / 卡组 / 战斗) 都是全屏浮层. 原来浮层是一层压暗的遮罩 + 一块不透明的
// 面板, 页面被完全挡住. 现在改成「垫底」样式: 面板本身半透明并带 backdrop-filter 高斯模糊,
// 身后的聊天记录/图片透出来但被磨砂虚化, 视觉上更像一块毛玻璃垫在页面上.
//
// 垫底色 / 不透明度 / 模糊半径 存在「脚本变量」里 (键 `面板外观`), 与对话、角色卡无关,
// 换聊天也不会丢; 三个面板共享同一份设置, 改一处三处一起变.
//
// 另外两档「弹窗不透明度 / 弹窗模糊半径」是给面板里那些**信息弹窗**用的 (战斗面板里的
// 卡牌详情 / 设置 / 调试 / 日志 / 回放). 它们是压在面板上的小块头, 压得太透就读不清字了,
// 所以默认比面板本身实一些 (0.96 对 0.62), 并且可以单独调.

import { z } from 'zod';

/** 外观设置在脚本变量中的键名 */
export const PANEL_LOOK_KEY = '面板外观';

/** 默认垫底色 (深色) */
export const DEFAULT_PANEL_TINT = '#0e1015';
/** 默认不透明度 */
export const DEFAULT_PANEL_ALPHA = 0.62;
/** 默认模糊半径 (px) */
export const DEFAULT_PANEL_BLUR = 10;
/** 模糊半径上限 (px) */
export const MAX_PANEL_BLUR = 30;

/** 默认弹窗不透明度 (弹窗里都是要读的字, 默认比面板实) */
export const DEFAULT_DIALOG_ALPHA = 0.96;
/** 默认弹窗模糊半径 (px) */
export const DEFAULT_DIALOG_BLUR = 10;
/** 弹窗模糊半径上限 (px) */
export const MAX_DIALOG_BLUR = 30;

/** 面板外的遮罩暗度 (固定值: 太暗会把透出来的页面压没) */
const MASK_ALPHA = 0.28;

/** 把各种写法归一成 `#rrggbb`; 认不出来时返回 null */
export function normalizeHex(input: unknown): string | null {
  const text = String(typeof input === 'string' ? input : '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(text)) {
    return `#${text[0]}${text[0]}${text[1]}${text[1]}${text[2]}${text[2]}`.toLowerCase();
  }
  if (/^[0-9a-f]{6}$/i.test(text)) {
    return `#${text.toLowerCase()}`;
  }
  return null;
}

/** `#rrggbb` → `r g b` (给 `rgb(var(--x) / a)` 用) */
export function hexToRgbParts(hex: string): string {
  const value = (normalizeHex(hex) ?? DEFAULT_PANEL_TINT).slice(1);
  const parts: number[] = [];
  for (let index = 0; index < 6; index += 2) {
    parts.push(Number.parseInt(value.slice(index, index + 2), 16));
  }
  return parts.join(' ');
}

/** 数值归一: 非法值回退, 并夹到 [min, max] */
function clampNumber(value: unknown, min: number, max: number, fallback: number, digits: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, number));
  const scale = 10 ** digits;
  return Math.round(clamped * scale) / scale;
}

/** 面板外观设置 */
export const PanelLookSchema = z.object({
  /** 垫底色 */
  垫底色: z
    .unknown()
    .optional()
    .transform(value => normalizeHex(value) ?? DEFAULT_PANEL_TINT),
  /** 垫底不透明度 (0 = 全透明, 1 = 不透) */
  不透明度: z
    .unknown()
    .optional()
    .transform(value => clampNumber(value, 0, 1, DEFAULT_PANEL_ALPHA, 2)),
  /** 高斯模糊半径 (px) */
  模糊半径: z
    .unknown()
    .optional()
    .transform(value => clampNumber(value, 0, MAX_PANEL_BLUR, DEFAULT_PANEL_BLUR, 0)),
  /** 弹窗不透明度 (面板里的信息弹窗; 0 = 全透明, 1 = 不透) */
  弹窗不透明度: z
    .unknown()
    .optional()
    .transform(value => clampNumber(value, 0, 1, DEFAULT_DIALOG_ALPHA, 2)),
  /** 弹窗高斯模糊半径 (px) */
  弹窗模糊半径: z
    .unknown()
    .optional()
    .transform(value => clampNumber(value, 0, MAX_DIALOG_BLUR, DEFAULT_DIALOG_BLUR, 0)),
});

export type PanelLook = z.infer<typeof PanelLookSchema>;

/** 默认外观 */
export function defaultPanelLook(): PanelLook {
  return PanelLookSchema.parse({});
}

/** 脚本变量是否可用 (node 测试环境下没有) */
function hasScriptVariables(): boolean {
  return typeof getVariables === 'function' && typeof getScriptId === 'function';
}

/** 内存缓存: 滑块拖动时面板要立刻跟着变, 不能等落盘 */
let cache: PanelLook | null = null;

/** 设置变化时的订阅者 (同一份脚本里的多个面板共享同一个模块实例) */
const listeners = new Set<() => void>();

/** 订阅外观变化, 返回取消订阅的函数 */
export function onPanelLookChanged(listener: () => void): () => void {
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
      /* 忽略: 单个订阅者出错不影响其它面板 */
    }
  }
}

/** 读取面板外观 (读不到或结构不对时回退到默认值) */
export function loadPanelLook(): PanelLook {
  if (cache) {
    return cache;
  }
  if (!hasScriptVariables()) {
    cache = defaultPanelLook();
    return cache;
  }
  try {
    const store = getVariables({ type: 'script', script_id: getScriptId() });
    const parsed = PanelLookSchema.safeParse(store?.[PANEL_LOOK_KEY]);
    cache = parsed.success ? parsed.data : defaultPanelLook();
  } catch {
    cache = defaultPanelLook();
  }
  return cache;
}

let persist_timer: ReturnType<typeof setTimeout> | null = null;

function persistNow(): void {
  if (!hasScriptVariables() || !cache) {
    return;
  }
  try {
    insertOrAssignVariables({ [PANEL_LOOK_KEY]: cache }, { type: 'script', script_id: getScriptId() });
  } catch (error) {
    console.warn('保存面板外观失败:', error);
  }
}

/** 立即落盘 (面板卸载前调用, 避免拖动中的改动丢失) */
export function flushPanelLookSave(): void {
  if (persist_timer !== null) {
    clearTimeout(persist_timer);
    persist_timer = null;
  }
  persistNow();
}

/** 保存面板外观: 立刻更新界面, 落盘做 250ms 防抖 (滑块拖动时不必每格都写) */
export function savePanelLook(look: Partial<PanelLook>): PanelLook {
  cache = PanelLookSchema.parse({ ...(cache ?? defaultPanelLook()), ...look });
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

/** 恢复默认外观 */
export function resetPanelLook(): PanelLook {
  return savePanelLook(defaultPanelLook());
}

/**
 * 生成挂在面板根节点上的 CSS 变量.
 *
 * 面板 CSS 里用 `rgb(var(--panel-tint) / var(--panel-alpha))` 当背景,
 * 用 `blur(var(--panel-blur))` 当 backdrop-filter;
 * 面板里的弹窗则用 `--panel-dialog-alpha` / `--panel-dialog-blur` (同样共用垫底色).
 */
export function panelLookStyle(look: PanelLook = loadPanelLook()): Record<string, string> {
  return {
    '--panel-tint': hexToRgbParts(look.垫底色),
    '--panel-alpha': String(look.不透明度),
    '--panel-blur': `${look.模糊半径}px`,
    '--panel-dialog-alpha': String(look.弹窗不透明度),
    '--panel-dialog-blur': `${look.弹窗模糊半径}px`,
    '--panel-mask': `rgb(8 9 13 / ${MASK_ALPHA})`,
  };
}

/** 界面上的灰色小字 */
export function describePanelLook(look: PanelLook = loadPanelLook()): string {
  return `垫底 ${look.垫底色} · 模糊 ${look.模糊半径}px · 弹窗 ${look.弹窗不透明度} / ${look.弹窗模糊半径}px`;
}
