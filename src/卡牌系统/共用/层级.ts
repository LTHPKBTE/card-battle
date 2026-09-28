// 数据层级: 卡牌与卡组可以放在三个位置, 面板读的是三处的**合并结果**
//
//   聊天   >  角色卡  >  全局
//   (小范围)              (大范围)
//
// 「小范围」看得见「大范围」的东西: 全局的卡牌在每张角色卡、每个对话里都可用;
// 角色卡的卡牌在这张角色卡下的所有对话里可用; 聊天的只在这一个对话里可用.
// 因为副本是各自独立的, 合并时同 id 只会来自同一次「移动」的中途 —— 那种情况下
// 小范围覆盖大范围, 与上面的可见性方向一致.
//
// 三个位置对应的酒馆变量域:
//   聊天   → 聊天变量 (chat)      —— 每个对话独立
//   角色卡 → 角色卡变量 (character) —— 这张角色卡的所有对话共享
//   全局   → 脚本变量 (script)     —— 所有角色卡、所有对话共享 (本脚本私有, 不污染别的脚本)
//
// 这里只负责「怎么读写某个层」与「怎么合并三层」, 具体的数据结构 (卡牌库 / 卡组)
// 由各自的 data.ts 决定; 迁移与警告文案由面板负责.

import { z } from 'zod';

/** 三个层级, 顺序即「范围从小到大」 */
export const DATA_LAYERS = ['聊天', '角色卡', '全局'] as const;
export type DataLayer = (typeof DATA_LAYERS)[number];

/** 一句说明, 用在选择器与警告弹窗里 */
export const LAYER_HINTS: Record<DataLayer, string> = {
  聊天: '只在这一个对话里能用',
  角色卡: '这张角色卡的每个对话都能用',
  全局: '所有角色卡、所有对话都能用',
};

/** 范围序号 (越大范围越广) */
export function layerRank(layer: DataLayer): number {
  return DATA_LAYERS.indexOf(layer);
}

/** 从 `from` 搬到 `to` 是否在缩小范围 (会让看得到它的别处用不了) */
export function isNarrowing(from: DataLayer, to: DataLayer): boolean {
  return layerRank(to) < layerRank(from);
}

/**
 * 这一层此刻能不能读写.
 *
 * 欢迎页没有角色卡, 临时聊天 / 欢迎页也可能没有聊天记录, 所以不能想当然地当它存在;
 * 面板据此把不能用的层灰掉, 而不是等写入时抛错.
 */
export function layerAvailable(layer: DataLayer): boolean {
  try {
    if (layer === '聊天') {
      return Boolean(SillyTavern.getCurrentChatId());
    }
    if (layer === '角色卡') {
      return Boolean(getCurrentCharacterId());
    }
    return typeof getScriptId === 'function';
  } catch {
    return false;
  }
}

/** 能用的层 (按范围从小到大), 供选择器列出 */
export function availableLayers(): DataLayer[] {
  return DATA_LAYERS.filter(layerAvailable);
}

/** 这一层对应的酒馆变量域 */
type LayerVariableOption = Parameters<typeof getVariables>[0];

function layerOption(layer: DataLayer): LayerVariableOption {
  if (layer === '聊天') {
    return { type: 'chat' };
  }
  if (layer === '角色卡') {
    return { type: 'character' };
  }
  return { type: 'script', script_id: getScriptId() };
}

/** 读某一层里的整份数据 (取不到时返回 undefined, 不抛) */
export function readLayer<T = any>(layer: DataLayer, key: string): T | undefined {
  try {
    return _.get(getVariables(layerOption(layer)), key) as T | undefined;
  } catch {
    return undefined;
  }
}

/** 写某一层里的某个键 (覆盖) */
export function writeLayer(layer: DataLayer, key: string, value: unknown): void {
  updateVariablesWith(
    variables => {
      _.set(variables, key, value);
      return variables;
    },
    layerOption(layer),
  );
}

/** 删掉某一层里的某个键 (不存在的键会被安全忽略) */
export function deleteLayerKey(layer: DataLayer, key: string): void {
  updateVariablesWith(
    variables => {
      _.unset(variables, key);
      return variables;
    },
    layerOption(layer),
  );
}

/** 三层里某一处的记录 (键是数据自己的 id) */
export type LayerRecords<T> = Partial<Record<DataLayer, Record<string, T>>>;

/** 合并后的一项: 生效的值 + 它来自哪一层 */
export interface Layered<T> {
  value: T;
  layer: DataLayer;
}

/**
 * 把三层的记录合并成「id → 生效项」.
 *
 * 大范围先铺, 小范围覆盖同名 id; 遍历顺序固定为 全局 → 角色卡 → 聊天, 所以返回的插入顺序
 * 是稳定的 (同名 id 只占第一次出现的位置).
 */
export function mergeLayers<T>(records: LayerRecords<T>): Map<string, Layered<T>> {
  const merged = new Map<string, Layered<T>>();
  for (const layer of [...DATA_LAYERS].reverse()) {
    const record = records[layer];
    if (!record) {
      continue;
    }
    for (const [id, value] of Object.entries(record)) {
      merged.set(id, { value, layer });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 位置偏好 (存脚本变量, 与对话 / 角色卡无关, 换聊天也不会丢)
// ---------------------------------------------------------------------------

/** 位置偏好在脚本变量里的键 */
export const LAYER_SETTINGS_KEY = '数据层级';

const DEFAULT_LAYER: DataLayer = '聊天';

function parseLayer(value: unknown): DataLayer {
  return DATA_LAYERS.includes(value as DataLayer) ? (value as DataLayer) : DEFAULT_LAYER;
}

/**
 * 位置偏好.
 *
 * `新建位置` 是面板上「新建的卡牌 / 卡组放哪」的选择器; `缩小时不再提示` 是那个
 * 「从大范围搬到小范围可能会让别处用不了」警告的开关 (关掉后仍然能搬, 只是不再弹).
 */
export const LayerSettingsSchema = z.object({
  新建位置: z
    .unknown()
    .optional()
    .transform(parseLayer),
  缩小时不再提示: z
    .unknown()
    .optional()
    .transform(value => value === true),
});
export type LayerSettings = z.infer<typeof LayerSettingsSchema>;

/** 默认位置偏好 */
export function defaultLayerSettings(): LayerSettings {
  return LayerSettingsSchema.parse({});
}

/** 脚本变量是否可用 (node 测试环境下没有) */
function hasScriptVariables(): boolean {
  return typeof getVariables === 'function' && typeof getScriptId === 'function';
}

let cache: LayerSettings | null = null;
const listeners = new Set<() => void>();

/** 订阅位置偏好变化, 返回取消订阅的函数 */
export function onLayerSettingsChanged(listener: () => void): () => void {
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
      /* 忽略: 单个订阅者出错不影响其他面板 */
    }
  }
}

/** 读取位置偏好 (读不到或结构不对时回退默认值) */
export function loadLayerSettings(): LayerSettings {
  if (cache) {
    return cache;
  }
  if (!hasScriptVariables()) {
    cache = defaultLayerSettings();
    return cache;
  }
  try {
    const store = getVariables({ type: 'script', script_id: getScriptId() });
    const parsed = LayerSettingsSchema.safeParse(store?.[LAYER_SETTINGS_KEY]);
    cache = parsed.success ? parsed.data : defaultLayerSettings();
  } catch {
    cache = defaultLayerSettings();
  }
  return cache;
}

let persist_timer: ReturnType<typeof setTimeout> | null = null;

function persistNow(): void {
  if (!hasScriptVariables() || !cache) {
    return;
  }
  try {
    insertOrAssignVariables({ [LAYER_SETTINGS_KEY]: cache }, { type: 'script', script_id: getScriptId() });
  } catch (error) {
    console.warn('保存数据位置偏好失败:', error);
  }
}

/** 立即落盘 (面板卸载前调用) */
export function flushLayerSettings(): void {
  if (persist_timer !== null) {
    clearTimeout(persist_timer);
    persist_timer = null;
  }
  persistNow();
}

/** 保存位置偏好: 界面立刻生效, 落盘做 250ms 防抖 */
export function saveLayerSettings(patch: Partial<LayerSettings>): LayerSettings {
  cache = LayerSettingsSchema.parse({ ...(cache ?? defaultLayerSettings()), ...patch });
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

/** 新建的卡牌 / 卡组默认放到哪一层 */
export function preferredLayer(): DataLayer {
  return loadLayerSettings().新建位置;
}

/** 从大范围搬到小范围时还要不要弹警告 */
export function shouldWarnOnNarrowing(): boolean {
  return !loadLayerSettings().缩小时不再提示;
}
