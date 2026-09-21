// 战斗 · 日志整理 (纯函数, 可在 node 中测试)
//
// 面板的「日志」弹窗有三个数据源, 这里把它们统一成一种列表项:
//   - 操作记录: 同步层 session.ops, 形如 `T3 玩家 上场「愿之芽」`
//   - 引擎日志: state.log (系统 / 事件 / 效果 / 数值 / 区域 / 状态 / 战斗)
//   - AI 决策  : store.结果 (多行文本: ✔ 执行 / ✖ 跳过 / 结算信息)
//
// 三个来源各自的顺序都是可靠的, 但它们之间的先后只能按回合近似对齐,
// 所以这里按「回合升序 → 来源顺序(操作 → 引擎 → 决策)」排列.
//
// 筛选模型 (面板的日志弹窗用):
//   - 标签多选: 来源 (操作 / AI决策) + 等级 (调试/信息/警告/错误) + 类别 (战斗/效果…);
//   - 标签之间按 OR / AND 组合 (`LogMatchMode`);
//   - 搜索词始终是 AND (先算标签集合, 再按正文/类别名过一遍);
//   - 默认只展示信息及以上 (`DEFAULT_LOG_FILTER_KEYS`), 但引擎把全部等级都记了下来.

import type { LogEntry, LogKind, LogLevel } from '../引擎/types.ts';
import { LOG_LEVELS } from '../引擎/types.ts';

/** 日志类别显示名 */
export const LOG_KIND_LABELS: Record<LogKind, string> = {
  SYSTEM: '系统',
  EVENT: '事件',
  EFFECT: '效果',
  MODIFY: '数值',
  ZONE: '区域',
  STATUS: '状态',
  COMBAT: '战斗',
};

/** 日志等级显示名 (与 LOG_LEVELS 一一对应) */
export const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  DEBUG: '调试',
  INFO: '信息',
  WARN: '警告',
  ERROR: '错误',
};

/** 日志来源: 操作记录 / 引擎日志 / AI 决策 */
export type LogSource = 'OP' | 'ENGINE' | 'AI';

/** 列表里的一条日志 */
export interface BattleLogItem {
  /** 渲染用的唯一 key */
  id: string;
  /** 发生回合 (解析不出来时为 0) */
  turn: number;
  source: LogSource;
  /** 类别显示名 (操作 / AI决策 / 系统 / 战斗 …) */
  label: string;
  /** 引擎日志的类别 (操作记录与 AI 决策为 null) */
  kind: LogKind | null;
  /** 引擎日志的等级 (操作记录与 AI 决策为 null) */
  level: LogLevel | null;
  /** 引擎内部问题 (卡牌库缺卡 / 事件连锁过深 …): 会记下来, 但不进 AI 简报 */
  internal: boolean;
  text: string;
}

/** 过滤项: 某个来源 / 某个引擎类别 / 某个等级 (不含「全部」) */
export type LogFilterKey = LogSource | LogKind | LogLevel;

/** 过滤项 (含「全部」, 兼容旧的单键筛选) */
export type LogFilter = 'ALL' | LogFilterKey;

/**
 * 日志弹窗上的过滤按钮, 按组渲染 (每组内部多选).
 *
 * 「类别」与「等级」是两个正交的维度: 类别说的是「哪一块」(战斗/效果/状态…),
 * 等级说的是「要不要看一眼」(调试/信息/警告/错误), 所以分开列比揉成一行好找.
 */
export const LOG_FILTER_GROUPS: {
  title: string;
  /** 分组右侧的小字提示 */
  hint?: string;
  options: { key: LogFilterKey; label: string }[];
}[] = [
  {
    title: '来源',
    options: [
      { key: 'OP', label: '操作' },
      { key: 'AI', label: 'AI决策' },
    ],
  },
  {
    title: '等级',
    hint: '默认只看信息及以上',
    options: [
      { key: 'DEBUG', label: '调试' },
      { key: 'INFO', label: '信息' },
      { key: 'WARN', label: '警告' },
      { key: 'ERROR', label: '错误' },
    ],
  },
  {
    title: '类别',
    options: [
      { key: 'COMBAT', label: '战斗' },
      { key: 'EFFECT', label: '效果' },
      { key: 'ZONE', label: '区域' },
      { key: 'STATUS', label: '状态' },
      { key: 'MODIFY', label: '数值' },
      { key: 'SYSTEM', label: '系统' },
      { key: 'EVENT', label: '事件' },
    ],
  },
];

/** 拍平后的全部过滤项 (含首项「全部」), 顺序 = 分组顺序 */
export const LOG_FILTERS: { key: LogFilter; label: string }[] = [
  { key: 'ALL', label: '全部' },
  ...LOG_FILTER_GROUPS.flatMap(group => group.options),
];

/** 默认筛选: 信息及以上 (拉不到调试) */
export const DEFAULT_LOG_FILTER_KEYS: readonly LogFilterKey[] = ['INFO', 'WARN', 'ERROR'];

/** 多选时的组合方式: 任一命中 / 全部命中 */
export type LogMatchMode = 'OR' | 'AND';

/** 一次筛选的完整条件 */
export interface LogQuery {
  /** 选中的过滤项 (空数组 = 不按标签筛) */
  keys: readonly LogFilterKey[];
  mode: LogMatchMode;
  /** 搜索词 (空格分隔的多个词需全部命中) */
  search: string;
}

/** 打开日志弹窗时的默认条件 */
export const DEFAULT_LOG_QUERY: LogQuery = {
  keys: DEFAULT_LOG_FILTER_KEYS,
  mode: 'OR',
  search: '',
};

/** 来源顺序 (同回合内的排列依据) */
const SOURCE_ORDER: Record<LogSource, number> = { OP: 0, ENGINE: 1, AI: 2 };

/** 操作记录格式: `T3 玩家 上场「xxx」` */
const OP_PATTERN = /^T(\d+)\s+(.*)$/;

/** 把一条操作记录拆成回合 + 正文 */
export function parseOpLine(line: string, index = 0): BattleLogItem {
  const match = OP_PATTERN.exec(line.trim());
  return {
    id: `op-${index}`,
    turn: match ? Number(match[1]) : 0,
    source: 'OP',
    label: '操作',
    kind: null,
    level: null,
    internal: false,
    text: match ? match[2] : line.trim(),
  };
}

/** 引擎日志 → 列表项 */
export function engineLogItems(entries: readonly LogEntry[]): BattleLogItem[] {
  return entries.map((entry, index) => ({
    id: `engine-${index}`,
    turn: entry.turn,
    source: 'ENGINE' as const,
    label: LOG_KIND_LABELS[entry.kind] ?? entry.kind,
    kind: entry.kind,
    level: entry.level ?? 'INFO',
    internal: Boolean(entry.engine_only),
    text: entry.message,
  }));
}

/** AI 决策结果 → 列表项 (没内容时返回 null) */
export function aiDecisionItem(text: string, turn = 0, index = 0): BattleLogItem | null {
  const body = String(text ?? '').trim();
  if (!body) {
    return null;
  }
  return { id: `ai-${index}`, turn, source: 'AI', label: 'AI决策', kind: null, level: null, internal: false, text: body };
}

/** 多条 AI 决策 → 列表项 (内存里累积的每回合结果) */
export function aiDecisionItems(texts: readonly string[], turn = 0): BattleLogItem[] {
  return texts
    .map((text, index) => aiDecisionItem(text, turn, index))
    .filter((item): item is BattleLogItem => Boolean(item));
}

/** 汇总全部日志 (操作 + 引擎 + AI 决策) */
export function collectBattleLogs(options: {
  ops?: readonly string[];
  log?: readonly LogEntry[];
  /** 单条 AI 决策结果 (变量里持久化的上一次结果) */
  ai?: string;
  /** 多条 AI 决策结果 (内存里累积的; 优先于 ai) */
  decisions?: readonly string[];
  /** AI 决策发生在第几回合 */
  aiTurn?: number;
}): BattleLogItem[] {
  const items: BattleLogItem[] = [];
  (options.ops ?? []).forEach((line, index) => items.push(parseOpLine(line, index)));
  items.push(...engineLogItems(options.log ?? []));
  const decisions = options.decisions?.length ? options.decisions : options.ai ? [options.ai] : [];
  items.push(...aiDecisionItems(decisions, options.aiTurn ?? 0));
  return items.sort((a, b) => a.turn - b.turn || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);
}

/** 这个字符串是不是日志等级 */
export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** 一条日志是否命中某个过滤项 */
export function matchLogKey(item: BattleLogItem, key: LogFilterKey): boolean {
  if (key === 'OP' || key === 'AI' || key === 'ENGINE') {
    return item.source === key;
  }
  if (isLogLevel(key)) {
    return item.level === key;
  }
  return item.kind === key;
}

/**
 * 搜索词是否命中 (空白分隔的多个词需要全部命中).
 *
 * 只匹配日志正文与类别名 —— 卡名/数值本来就在正文里, 不用额外索引.
 */
export function matchesSearch(item: BattleLogItem, search: string): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = `${item.text} ${item.label}`.toLowerCase();
  return words.every(word => haystack.includes(word));
}

/**
 * 按条件筛选 (返回新数组).
 *
 * 规则:
 * - 搜索词始终是 AND (先算标签集合, 再按搜索词过一遍);
 * - 选中的标签按 `mode` 组合: `OR` = 任一命中, `AND` = 全部命中;
 * - 一个标签都没选 = 不按标签筛 (只剩搜索词生效).
 */
export function filterLogs(items: readonly BattleLogItem[], query: LogQuery): BattleLogItem[] {
  const keys = query.keys;
  return items.filter(item => {
    if (!matchesSearch(item, query.search)) {
      return false;
    }
    if (keys.length === 0) {
      return true;
    }
    if (query.mode === 'AND') {
      return keys.every(key => matchLogKey(item, key));
    }
    return keys.some(key => matchLogKey(item, key));
  });
}

/** 单键筛选 (`'ALL'` = 不过滤); 面板已改用 filterLogs, 这里留给简单场景与测试 */
export function filterBattleLogs(items: readonly BattleLogItem[], filter: LogFilter): BattleLogItem[] {
  if (filter === 'ALL') {
    return items.slice();
  }
  return items.filter(item => matchLogKey(item, filter));
}

/** 各过滤项下的条数 (按钮上显示角标用) */
export function logCounts(items: readonly BattleLogItem[]): Record<string, number> {
  const counts: Record<string, number> = { ALL: items.length, OP: 0, AI: 0, ENGINE: 0 };
  for (const kind of Object.keys(LOG_KIND_LABELS) as LogKind[]) {
    counts[kind] = 0;
  }
  for (const level of LOG_LEVELS) {
    counts[level] = 0;
  }
  for (const item of items) {
    counts[item.source] += 1;
    if (item.kind) {
      counts[item.kind] += 1;
    }
    if (item.level) {
      counts[item.level] += 1;
    }
  }
  return counts;
}
