// AI 辅助写卡 - 输出解析与规范化
//
// 模型输出并不总是干净的 JSON: 可能包着 Markdown 代码块、前后带解释、尾逗号等.
// 这里统一负责「取出 JSON → 宽松解析 → 按卡牌 schema 补齐默认值」.
//
// 本模块必须能在 node 里独立跑测试, 因此不依赖酒馆注入的全局变量 (z / YAML / _).

import JSON5 from 'json5';
import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';

import { CARD_FACTIONS, MAX_STARS, RARITIES, type CardFaction } from '../卡牌/schema.ts';

/** 从文本中取出第一个 Markdown 代码块的内容; 没有代码块时返回原文本 */
export function extractCodeBlock(text: string): string {
  const match = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```/.exec(text);
  return (match ? match[1] : text).trim();
}

/**
 * 从文本中截取第一个完整的 JSON 对象/数组.
 *
 * 用于模型在 JSON 前后加了说明文字的情况; 会正确处理字符串内的括号与转义.
 * 找不到完整结构时返回 null.
 */
export function extractFirstJson(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) {
    return null;
  }
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let in_string = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (in_string) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        in_string = false;
      }
      continue;
    }
    if (char === '"') {
      in_string = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

/**
 * 宽松解析模型输出的 JSON.
 *
 * 顺序: 代码块内容 → JSON5 → jsonrepair + JSON.parse → 截取第一个 JSON 结构后重试.
 */
export function parseAiJson(text: string): unknown {
  const block = extractCodeBlock(text);
  const candidates = [block];
  const extracted = extractFirstJson(block);
  if (extracted && extracted !== block) {
    candidates.push(extracted);
  }

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      // eslint-disable-next-line import-x/no-named-as-default-member
      parsed = JSON5.parse(trimmed);
    } catch {
      try {
        parsed = JSON.parse(jsonrepair(trimmed));
      } catch {
        continue;
      }
    }
    // jsonrepair 会把彻底不合法的文本修成字符串 (如 "abc"), 这里只接受对象/数组
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
  }
  throw new Error(`AI 返回的内容不是可解析的 JSON: ${block.slice(0, 120)}`);
}

/** 把任意值转成字符串 (null/undefined → 空字符串) */
const StatTextSchema = z.preprocess(
  value => (value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)),
  z.string(),
);

/** 把任意值转成 0-8 的星数 */
const AiStarsSchema = z.preprocess(value => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(Math.max(Math.trunc(numeric), 0), MAX_STARS) : 0;
}, z.number().int().min(0).max(MAX_STARS));

/** 把任意值转成合法稀有度 (非法值退回 N) */
const AiRaritySchema = z.preprocess(
  value => (RARITIES.includes(value as never) ? value : 'N'),
  z.enum(RARITIES),
);

/**
 * AI 生成的卡牌草稿 (不含 id / created_at, 由调用方补齐).
 * 所有字段都有兜底, 只有 name 必须非空 (在 normalizeAiCard 里检查).
 */
export const AiCardSchema = z.object({
  name: z.string().prefault(''),
  series: z.string().prefault(''),
  阵营: z.enum(CARD_FACTIONS).prefault('通用'),
  rarity: AiRaritySchema,
  stars: AiStarsSchema,
  type: z.string().prefault('从者'),
  attribute: z.string().prefault(''),
  gender: z.string().prefault(''),
  race: z.string().prefault(''),
  height: StatTextSchema,
  atk: StatTextSchema,
  shield: StatTextSchema,
  hp: StatTextSchema,
  energy: StatTextSchema,
  description: z.string().prefault(''),
  machine_effect: z.unknown().optional(),
});
export type AiCardDraft = z.output<typeof AiCardSchema>;

/** 判断是否普通对象 (排除数组与 null) */
export function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 卡牌字段的中文/别名键 → 内部英文键.
 *
 * 模型有时会忽略 json_schema 自己起中文键名, 这里统一映射一次.
 */
const CARD_KEY_ALIASES: Record<string, string> = {
  卡名: 'name',
  名称: 'name',
  系列: 'series',
  系列名: 'series',
  稀有度: 'rarity',
  星级: 'stars',
  星数: 'stars',
  类型: 'type',
  属性: 'attribute',
  性别: 'gender',
  种族: 'race',
  身高: 'height',
  攻击: 'atk',
  攻击力: 'atk',
  护盾: 'shield',
  护盾值: 'shield',
  盾: 'shield',
  // 旧提示词里叫「防御」, 模型可能沿用, 统一当成护盾处理
  防御: 'shield',
  防御力: 'shield',
  生命: 'hp',
  生命值: 'hp',
  血量: 'hp',
  能量: 'energy',
  费用: 'energy',
  消耗: 'energy',
  效果描述: 'description',
  描述: 'description',
  机读效果: 'machine_effect',
  机读: 'machine_effect',
};

/** 把中文/别名键名映射成内部英文键 (不覆盖已存在的英文键) */
function normalizeCardKeys(raw: Record<string, any>): Record<string, any> {
  const fixed: Record<string, any> = { ...raw };
  for (const [alias, key] of Object.entries(CARD_KEY_ALIASES)) {
    if (fixed[key] === undefined && fixed[alias] !== undefined) {
      fixed[key] = fixed[alias];
    }
  }
  return fixed;
}

/** 是否看起来像一张卡牌 (用于判断能不能拆外层包装) */
function looksLikeCard(value: unknown): value is Record<string, any> {
  return isPlainObject(value) && ('name' in value || '卡名' in value);
}

/** 模型可能把单张卡包在 {"card": {...}} / {"卡牌": {...}} 里 */
function unwrapCard(raw: unknown): unknown {
  if (!isPlainObject(raw)) {
    return raw;
  }
  for (const key of ['card', '卡牌', 'data', 'result']) {
    if (looksLikeCard(raw[key])) {
      return raw[key];
    }
  }
  return raw;
}

/**
 * 规范化一张 AI 生成的卡牌.
 *
 * - `阵营` 强制使用调用方给的阵营 (不信任模型)
 * - `machine_effect` 若是字符串, 尝试当 JSON 解析 (失败则丢弃)
 * - 卡名为空时抛错
 */
export function normalizeAiCard(raw: unknown, faction: CardFaction): AiCardDraft {
  const source = unwrapCard(raw);
  if (!isPlainObject(source)) {
    throw new Error('AI 没有返回卡牌对象');
  }
  const fixed: Record<string, any> = { ...normalizeCardKeys(source), 阵营: faction };
  if (typeof fixed.machine_effect === 'string') {
    const text = fixed.machine_effect.trim();
    if (!text) {
      delete fixed.machine_effect;
    } else {
      try {
        fixed.machine_effect = parseAiJson(text);
      } catch {
        delete fixed.machine_effect;
      }
    }
  }
  if (fixed.machine_effect === null) {
    delete fixed.machine_effect;
  }

  const card = AiCardSchema.parse(fixed);
  if (!card.name.trim()) {
    throw new Error('AI 返回的卡牌缺少卡名');
  }
  card.name = card.name.trim();
  return card;
}

/** AI 生成的卡组草稿 */
export interface AiDeckDraft {
  名称: string;
  备注: string;
  卡牌: AiCardDraft[];
}

/** 卡组里卡牌数组可能的键名 (模型忽略 json_schema 时常见 cards / list) */
const DECK_LIST_KEYS = ['卡牌', 'cards', 'card_list', 'cardList', 'list', 'items', '卡牌列表'];
/** 外层包装可能的键名 ({"卡组": {"卡牌": [...]}}) */
const DECK_WRAP_KEYS = ['卡组', 'deck', 'data', 'result'];
/** 份数可能的键名 */
const QUANTITY_KEYS = ['数量', 'quantity', 'count', '份数', 'copies', 'qty', 'num'];

/** 从模型输出里取出卡牌数组 (兼容裸数组 / 各种外层包装 / 英文键名) */
function pickCardList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (!isPlainObject(raw)) {
    return [];
  }
  for (const key of DECK_LIST_KEYS) {
    if (Array.isArray(raw[key])) {
      return raw[key];
    }
  }
  for (const wrap of DECK_WRAP_KEYS) {
    const inner = raw[wrap];
    if (!isPlainObject(inner)) {
      continue;
    }
    for (const key of DECK_LIST_KEYS) {
      if (Array.isArray(inner[key])) {
        return inner[key];
      }
    }
  }
  return [];
}

/** 取出某项携带的份数 (默认 1, 不认识的值也当 1) */
function pickQuantity(item: unknown): number {
  if (!isPlainObject(item)) {
    return 1;
  }
  for (const key of QUANTITY_KEYS) {
    const value = item[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const count = Math.trunc(Number(value));
    if (Number.isFinite(count) && count > 0) {
      return count;
    }
  }
  return 1;
}

/** 取卡组名/备注 (兼容 note / memo 等英文键) */
function pickText(raw: Record<string, any>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

/**
 * 规范化 AI 生成的卡组.
 *
 * 兼容的写法 (模型忽略 json_schema 时经常换一种):
 *  - `{ "卡牌": [...] }` / `{ "cards": [...] }` / 直接给数组
 *  - 卡牌用 `数量` / `quantity` / `count` 表示份数, 省略表示 1 份
 * 单张卡牌解析失败会被跳过, 并把原因写进 `warnings`.
 */
export function normalizeAiDeck(
  raw: unknown,
  faction: CardFaction,
  options: { limit?: number } = {},
): AiDeckDraft & { warnings: string[] } {
  const list = pickCardList(raw);
  if (list.length === 0) {
    const keys = isPlainObject(raw) ? Object.keys(raw).join(', ') : typeof raw;
    throw new Error(`AI 没有返回任何卡牌 (顶层内容: ${keys || '空'})`);
  }
  const limit = Math.max(1, Math.trunc(options.limit ?? 30));

  const warnings: string[] = [];
  const cards: AiCardDraft[] = [];
  let truncated = false;
  for (const item of list) {
    if (cards.length >= limit) {
      truncated = true;
      break;
    }
    const count = Math.max(1, Math.min(3, pickQuantity(item)));
    try {
      const card = normalizeAiCard(item, faction);
      for (let copy = 0; copy < count; copy += 1) {
        if (cards.length >= limit) {
          truncated = true;
          break;
        }
        cards.push(card);
      }
    } catch (error) {
      const name = isPlainObject(item) && item.name ? String(item.name) : '未命名卡牌';
      warnings.push(`「${name}」解析失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (truncated) {
    warnings.push(`卡牌数量超过上限 ${limit}, 已截断`);
  }
  if (cards.length === 0) {
    throw new Error(`AI 返回的卡牌全部无法解析:\n${warnings.join('\n')}`);
  }

  const meta = isPlainObject(raw) ? raw : {};
  return {
    名称: pickText(meta, ['名称', 'name', 'deck_name', '卡组名']) || `AI ${faction}卡组`,
    备注: pickText(meta, ['备注', 'note', 'memo', 'description']),
    卡牌: cards,
    warnings,
  };
}

/** 供提示词使用的「机读效果错误」描述 */
export function formatMachineEffectError(error: string | null): string {
  return error ? `机读效果校验失败: ${error}` : '';
}
