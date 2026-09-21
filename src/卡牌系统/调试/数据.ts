// 全局调试 · 数据占用 (面板「调试」按钮的数据源)
//
// 排查「变量莫名膨胀」时最想知道的只有一件事: 谁占了多少.
// 这里把三个作用域 (角色卡 / 聊天 / 脚本) 的变量逐层量一遍:
//
//   顶层命名空间  —— 卡牌库 / 卡组 / 战斗 / 面板外观 … 各占多少;
//   叶子路径      —— 再往下钻, 具体是哪个条目撑大了命名空间 (只列最大的若干条).
//
// 量的是 JSON 序列化后的 UTF-8 字节数 —— 酒馆把变量整份写进聊天文件, 字节数就是真实代价
// (中文一个字占 3 字节, 按「字符数」会低估两三倍).
//
// 除 collectDebugScopes / debugEnvironment 外都是纯函数, 可以直接在 node 里测.

import { jsonBytes } from '../共用/体积.ts';

/** 变量作用域 (不列全局变量: 它跨对话共享, 容易与卡牌数据混淆) */
export type ScopeKey = 'character' | 'chat' | 'script';

/** 每个作用域的顶层命名空间默认最多列出多少条 (更多的折叠起来) */
export const DEBUG_TOP_LIMIT = 10;

/** 每个作用域最多列出多少条叶子 */
export const DEBUG_LEAF_LIMIT = 60;

/** 叶子往下钻的最大层数 */
export const DEBUG_LEAF_DEPTH = 6;

/** 一次最多访问多少个节点 (卡牌库可能很大, 防卡死) */
export const DEBUG_SCAN_LIMIT = 6000;

/** 变量 JSON 预览最多展示多少字符 */
export const DEBUG_JSON_LIMIT = 20000;

/** 一行占用数据 */
export interface SizeRow {
  /** 完整路径 (顶层命名空间下不带前缀, 叶子带 `a.b[0].c`) */
  路径: string;
  /** JSON 字节数 */
  字节数: number;
  /** 容器里的条目数 (叶子为 0) */
  条目数: number;
  /** 类型说明 */
  类型: string;
}

/** 一个作用域的量测结果 */
export interface ScopeReport {
  key: ScopeKey;
  /** 面板上的小标题 */
  标题: string;
  /** 这个作用域存在哪里的说明 */
  说明: string;
  /** 是否读到了数据 */
  可读: boolean;
  /** 读不到时的原因 */
  错误: string;
  /** 顶层命名空间 (大 → 小) */
  顶层: SizeRow[];
  /** 叶子明细 (大 → 小) */
  叶子: SizeRow[];
  /** 合计字节数 */
  合计: number;
  /** 变量 JSON 预览 (过长截断) */
  json: string;
  /** JSON 预览是否被截断 */
  json_truncated: boolean;
}

/** 值的类型说明 (带条目数 / 长度) */
export function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (Array.isArray(value)) {
    return `数组(${value.length})`;
  }
  switch (typeof value) {
    case 'object':
      return `对象(${Object.keys(value as object).length})`;
    case 'string':
      return `字符串(${(value as string).length} 字)`;
    case 'number':
      return '数字';
    case 'boolean':
      return '布尔';
    default:
      return typeof value;
  }
}

/** 是不是可以继续往下钻的容器 */
function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

/** 容器里的条目数 (不是容器时为 0) */
function countEntries(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (isContainer(value)) {
    return Object.keys(value).length;
  }
  return 0;
}

/**
 * 展开叶子路径 (大 → 小).
 *
 * 「叶子」= 不再是容器的值, 或达到层数上限的容器;
 * 卡牌库这种超大的数据里, 真正的占用大头往往就在某个数组元素上.
 */
export function flattenLeaves(value: unknown, limit = DEBUG_LEAF_LIMIT): SizeRow[] {
  const rows: SizeRow[] = [];
  let visited = 0;

  function walk(node: unknown, path: string, depth: number): void {
    if (visited >= DEBUG_SCAN_LIMIT) {
      return;
    }
    visited += 1;
    const entries = countEntries(node);
    if (isContainer(node) && depth < DEBUG_LEAF_DEPTH && entries > 0) {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      } else {
        for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
          walk(item, path ? `${path}.${key}` : key, depth + 1);
        }
      }
      return;
    }
    rows.push({ 路径: path, 字节数: jsonBytes(node), 条目数: entries, 类型: describeValue(node) });
  }

  walk(value, '', 0);
  return rows.sort((left, right) => right.字节数 - left.字节数).slice(0, limit);
}

/** 序列化变量为可读 JSON (过长截断) */
function safeJson(value: unknown): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? '';
  } catch (error) {
    return { text: `(无法序列化: ${String(error)})`, truncated: false };
  }
  if (text.length <= DEBUG_JSON_LIMIT) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, DEBUG_JSON_LIMIT), truncated: true };
}

/**
 * 量一个作用域 (纯函数).
 *
 * @param value 已经取好的变量对象; 读不到时传 null 并把原因写进 `错误`
 */
export function buildScopeReport(params: {
  key: ScopeKey;
  标题: string;
  说明: string;
  value: unknown;
  /** 读变量时的错误原文 */
  错误?: string;
  /** 叶子条数上限 */
  leaf_limit?: number;
}): ScopeReport {
  const value = params.value;
  const available = Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const json = safeJson(value ?? null);
  const root = available ? (value as Record<string, unknown>) : {};

  const 顶层: SizeRow[] = Object.entries(root)
    .map(([key, item]) => ({
      路径: key,
      字节数: jsonBytes(item),
      条目数: countEntries(item),
      类型: describeValue(item),
    }))
    .sort((left, right) => right.字节数 - left.字节数);

  return {
    key: params.key,
    标题: params.标题,
    说明: params.说明,
    可读: available,
    错误: params.错误 ?? '',
    顶层,
    叶子: available ? flattenLeaves(root, params.leaf_limit ?? DEBUG_LEAF_LIMIT) : [],
    合计: available ? jsonBytes(root) : 0,
    json: json.text,
    json_truncated: json.truncated,
  };
}

/** 环境信息的一行 (角色 / 对话 / 脚本) */
export interface EnvRow {
  标签: string;
  值: string;
}

/** 取一条环境信息 (读不到时给个说明, 不抛错) */
function safeEnv(label: string, read: () => unknown): EnvRow {
  try {
    const value = read();
    const text = value === null || value === undefined || value === '' ? '(无)' : String(value);
    return { 标签: label, 值: text };
  } catch (error) {
    return { 标签: label, 值: `(读取失败: ${String(error)})` };
  }
}

/** 当前环境: 角色 / 对话 / 脚本 / 时间 */
export function debugEnvironment(): EnvRow[] {
  return [
    safeEnv('角色卡', () => getCurrentCharacterId()),
    safeEnv('对话', () => SillyTavern.getCurrentChatId()),
    safeEnv('脚本', () => getScriptId()),
    safeEnv('时间', () => new Date().toLocaleString()),
  ];
}

/** 三个作用域的标题与说明 (面板与测试共用) */
export const SCOPE_META: readonly { key: ScopeKey; 标题: string; 说明: string }[] = [
  { key: 'character', 标题: '角色卡变量', 说明: '卡牌库 (所有卡牌定义) 存在这里' },
  { key: 'chat', 标题: '聊天变量', 说明: '卡组、出战卡组、战斗快照与回放存在这里' },
  { key: 'script', 标题: '脚本变量', 说明: '面板外观等设置存在这里' },
];

/** 读一个作用域的变量; 读不到时返回错误原因 */
function readScope(key: ScopeKey): { value: unknown; 错误: string } {
  try {
    const value = getVariables({ type: key });
    return { value: value ?? {}, 错误: '' };
  } catch (error) {
    return { value: null, 错误: error instanceof Error ? error.message : String(error) };
  }
}

/** 量全部作用域 (面板调用; 会碰酒馆全局) */
export function collectDebugScopes(): ScopeReport[] {
  return SCOPE_META.map(meta => {
    const { value, 错误 } = readScope(meta.key);
    return buildScopeReport({ key: meta.key, 标题: meta.标题, 说明: meta.说明, value, 错误 });
  });
}
