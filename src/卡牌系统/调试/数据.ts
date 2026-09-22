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
import { CARD_LIBRARY_KEY } from '../卡牌/schema.ts';
import { BATTLE_CHAT_KEY, DECK_CHAT_KEY, DEPLOYED_DECK_KEY } from '../卡组/schema.ts';

/** 变量作用域 (不列全局变量: 它跨对话共享, 容易与卡牌数据混淆) */
export type ScopeKey = 'character' | 'chat' | 'script';

/**
 * 面板里每个列表默认最多显示多少条 (顶层命名空间 / 占用最大的条目 / 最近的通知),
 * 更多的收起来 —— 卡牌库一多, 全量铺开会刷屏到没法看.
 */
export const DEBUG_LIST_LIMIT = 10;

/** 每个作用域最多列出多少条叶子 */
export const DEBUG_LEAF_LIMIT = 60;

/** 叶子往下钻的最大层数 */
export const DEBUG_LEAF_DEPTH = 6;

/** 一次最多访问多少个节点 (卡牌库可能很大, 防卡死) */
export const DEBUG_SCAN_LIMIT = 6000;

/** 变量 JSON 预览最多展示多少字符 */
export const DEBUG_JSON_LIMIT = 20000;

/**
 * 可读名标签: 数据里的对象大多只以 uuid 为键, 光看路径认不出是哪张卡 / 哪个卡组,
 * 能从数据里解析出名字时就在行上标一个.
 */
export interface NameTag {
  /** 标签文本 (卡名 / 卡组名) */
  文本: string;
  /** 数据种类 (只用于区分样式) */
  种类: '卡牌' | '卡组';
}

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
  /** 这一条属于哪张卡 / 哪个卡组 (认不出来时没有) */
  标签?: NameTag;
}

/**
 * `id → 可读名` 索引.
 * 调试面板只负责「量占用」, 名字全部从变量里现读, 不依赖卡牌库能否正常解析.
 */
export interface NameLookup {
  /** 卡牌 id → 卡名 */
  卡牌: Map<string, string>;
  /** 卡组 id → 卡组名 */
  卡组: Map<string, string>;
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

/** 当成对象读 (数组也算: 卡组里存的卡牌列表就是数组) */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isContainer(value) ? (value as Record<string, unknown>) : undefined;
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

/** 取条目上的可读名 (卡牌是 `name`, 卡组是 `名称`; 没有或为空就当认不出来) */
function pickName(record: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

/** 把 `{ id: 条目 }` 表读成 `id → 名字` (`id` 字段优先, 缺失时用键) */
function collectNames(table: unknown, fields: readonly string[], target: Map<string, string>): void {
  const rows = asRecord(table);
  if (!rows) {
    return;
  }
  for (const [key, entry] of Object.entries(rows)) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const id = typeof record.id === 'string' && record.id ? record.id : key;
    const name = pickName(record, fields);
    if (name) {
      target.set(id, name);
    }
  }
}

/**
 * 从各作用域的变量里抽出 `id → 可读名` (纯函数).
 *
 * 认的地方: 角色卡的 `卡牌库.卡牌`、聊天变量的 `卡组.卡组`, 以及出战卡组快照
 * (里面有来源卡组 id 与整份卡牌副本) —— 这几处的 uuid 是面板上最需要看懂的.
 */
export function buildNameLookup(values: Partial<Record<ScopeKey, unknown>>): NameLookup {
  const lookup: NameLookup = { 卡牌: new Map(), 卡组: new Map() };

  const character = asRecord(values.character);
  collectNames(asRecord(asRecord(character?.[CARD_LIBRARY_KEY])?.卡牌), ['name'], lookup.卡牌);

  const chat = asRecord(values.chat);
  collectNames(asRecord(asRecord(chat?.[DECK_CHAT_KEY])?.卡组), ['名称'], lookup.卡组);

  const deployed = asRecord(asRecord(chat?.[BATTLE_CHAT_KEY])?.[DEPLOYED_DECK_KEY]);
  if (deployed) {
    const deck_id = typeof deployed.卡组id === 'string' ? deployed.卡组id : '';
    const deck_name = pickName(deployed, ['名称']);
    if (deck_id && deck_name) {
      lookup.卡组.set(deck_id, deck_name);
    }
    collectNames(deployed.卡牌, ['name'], lookup.卡牌);
  }

  return lookup;
}

/** 已知 id → 标签 (卡牌优先, 再认卡组; 认不出来就没有) */
function tagForId(id: unknown, lookup: NameLookup): NameTag | undefined {
  if (typeof id !== 'string' || !id) {
    return undefined;
  }
  const card = lookup.卡牌.get(id);
  if (card) {
    return { 文本: card, 种类: '卡牌' };
  }
  const deck = lookup.卡组.get(id);
  if (deck) {
    return { 文本: deck, 种类: '卡组' };
  }
  return undefined;
}

/** 这个节点自己认不认识自己 (卡牌 / 卡组对象上都写着 `id`) */
function tagOfNode(node: unknown, lookup: NameLookup): NameTag | undefined {
  return tagForId(asRecord(node)?.id, lookup);
}

/**
 * 展开叶子路径 (大 → 小).
 *
 * 「叶子」= 不再是容器的值, 或达到层数上限的容器;
 * 卡牌库这种超大的数据里, 真正的占用大头往往就在某个数组元素上.
 *
 * 传入 `lookup` 时, 落到某张卡 / 某个卡组里的叶子会带上它的名字 (见 SizeRow.标签).
 */
export function flattenLeaves(value: unknown, limit = DEBUG_LEAF_LIMIT, lookup?: NameLookup): SizeRow[] {
  const rows: SizeRow[] = [];
  let visited = 0;

  function walk(node: unknown, path: string, depth: number, tag: NameTag | undefined): void {
    if (visited >= DEBUG_SCAN_LIMIT) {
      return;
    }
    visited += 1;
    const entries = countEntries(node);
    const own = lookup ? tagOfNode(node, lookup) : undefined;
    const current = own ?? tag;
    if (isContainer(node) && depth < DEBUG_LEAF_DEPTH && entries > 0) {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1, current));
      } else {
        for (const [key, item] of Object.entries(node)) {
          walk(item, path ? `${path}.${key}` : key, depth + 1, current);
        }
      }
      return;
    }
    // 优先自己的 id, 其次「这个值本身就是某张卡的 id」(卡组里存的就是 id 列表), 最后才是从上层继承来的
    const row_tag = lookup ? (own ?? tagForId(node, lookup) ?? tag) : undefined;
    rows.push({
      路径: path,
      字节数: jsonBytes(node),
      条目数: entries,
      类型: describeValue(node),
      ...(row_tag ? { 标签: row_tag } : {}),
    });
  }

  walk(value, '', 0, undefined);
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
  /** `id → 可读名` 索引 (给叶子行标名字用, 不给就没有标签) */
  names?: NameLookup;
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
    叶子: available ? flattenLeaves(root, params.leaf_limit ?? DEBUG_LEAF_LIMIT, params.names) : [],
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
  const loaded = SCOPE_META.map(meta => ({ meta, ...readScope(meta.key) }));

  // 先把三份变量都读出来, 才能用卡牌库给聊天变量里的 uuid 标上名字
  const names = buildNameLookup(
    Object.fromEntries(loaded.map(item => [item.meta.key, item.value])) as Partial<Record<ScopeKey, unknown>>,
  );

  return loaded.map(({ meta, value, 错误 }) =>
    buildScopeReport({ key: meta.key, 标题: meta.标题, 说明: meta.说明, value, 错误, names }),
  );
}
