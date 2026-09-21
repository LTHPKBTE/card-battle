// AI 辅助写卡 - 三个具体任务
//
// 1. 写机读: 把自然语言效果翻译成机读效果 (用户不需要懂机读语法)
// 2. 生成卡牌: 按用户需求写一张新卡 (可用于我方或敌方)
// 3. 生成卡组: 写一整套新卡组, 或往已有卡组里补充新卡
//
// 三个任务都走 `generateRaw` 独立请求: 不注入世界书、不占用聊天楼层.
// 请求本身由 `卡牌请求` / `卡组请求` 两个纯函数构造 (便于测试, 也方便界面
// 告诉用户「这次会发送什么、会不会带聊天记录」).
//
// 提示词文本 (规范 / 任务说明) 都从 提示词.ts 取, 用户可以查看与自定义.

import { parseMachineEffect } from '../引擎/schema.ts';
import { RARITIES, type Card, type CardFaction } from '../卡牌/schema.ts';
import { aiGenerate, aiGenerateJson, type AiRequest } from './客户端.ts';
import { isPlainObject, normalizeAiCard, normalizeAiDeck, parseAiJson, type AiCardDraft } from './解析.ts';
import { promptText, promptTextFilled } from './提示词.ts';

// ---------------------------------------------------------------------------
// 通用: 卡面摘要
// ---------------------------------------------------------------------------

/** describeCard 需要的字段 (兼容卡牌库的 Card 与 AI 生成的草稿) */
type CardLike = Pick<
  Card,
  'name' | 'series' | 'rarity' | 'stars' | 'type' | 'attribute' | 'atk' | 'shield' | 'hp' | 'energy' | 'description'
> & { machine_effect?: unknown };

/** 把多行文本压成单行 (提示词里的卡牌列表是逐行结构, 不能被描述里的换行打断) */
function oneLine(text: string): string {
  return String(text ?? '')
    .replace(/\s*\r?\n+\s*/g, ' / ')
    .trim();
}

/** 把一张卡牌压缩成提示词用的多行摘要 */
export function describeCard(card: CardLike): string {
  const lines = [
    `卡名: ${card.name}`,
    card.series ? `系列: ${card.series}` : '',
    `稀有度 / 星级: ${card.rarity} / ${card.stars}`,
    `类型 / 属性: ${card.type}${card.attribute ? ` · ${card.attribute}` : ''}`,
    `ATK / 护盾 / HP: ${card.atk} / ${card.shield} / ${card.hp}`,
    card.energy ? `能量: ${card.energy}` : '',
    card.description ? `效果描述: ${oneLine(card.description)}` : '',
    card.machine_effect ? `机读效果: ${JSON.stringify(card.machine_effect)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** 卡组摘要: 逐卡一行 + 稀有度/数值统计 */
export function describeDeck(cards: Card[], options: { max_cards?: number } = {}): string {
  if (cards.length === 0) {
    return '(空卡组)';
  }
  const max_cards = options.max_cards ?? 40;
  // 卡组里同一张卡的多份是「重复的 id」, 这里合并成一行「×N」再发给 AI,
  // 避免同一张卡的摘要重复 N 遍浪费 token; 按 id 分组 (而不是按卡名),
  // 免得同名的不同卡牌被错并成一条、数值也只取到第一张的.
  const groups = new Map<string, { card: Card; count: number }>();
  for (const card of cards) {
    const key = card.id || `${card.name}|${card.atk}|${card.shield}|${card.hp}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
    } else {
      groups.set(key, { card, count: 1 });
    }
  }
  const rows = [...groups.values()].slice(0, max_cards).map(({ card, count }) => {
    const name = card.name || '未命名';
    const effect = card.machine_effect ? ` | 机读: ${JSON.stringify(card.machine_effect).slice(0, 160)}` : '';
    const description = card.description ? ` | ${oneLine(card.description).slice(0, 80)}` : '';
    return `- ${name} ×${count} [${card.rarity}/${card.stars}星 ${card.type}] ATK ${card.atk} 护盾 ${card.shield} HP ${card.hp}${description}${effect}`;
  });

  const rarity_count = RARITIES.map(rarity => {
    const count = cards.filter(card => card.rarity === rarity).length;
    return count ? `${rarity}×${count}` : '';
  }).filter(Boolean);

  const parseStat = (text: string) => {
    const match = String(text ?? '').match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  };
  const average = (values: number[]) =>
    values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;

  return [
    `总张数: ${cards.length}`,
    `稀有度分布: ${rarity_count.join(' ') || '无'}`,
    `平均 ATK ${average(cards.map(card => parseStat(card.atk)))} / HP ${average(cards.map(card => parseStat(card.hp)))}`,
    '卡牌列表:',
    ...rows,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

/** 单张卡牌的 JSON Schema 属性 (供结构化输出使用) */
const CARD_PROPERTIES: Record<string, any> = {
  name: { type: 'string', description: '卡名' },
  series: { type: 'string', description: '系列名, 无则空字符串' },
  rarity: { type: 'string', enum: [...RARITIES] },
  stars: { type: 'integer', minimum: 0, maximum: 8 },
  type: { type: 'string', description: '从者/魔法/咒术/道具/陷阱/场地/联动' },
  attribute: { type: 'string' },
  gender: { type: 'string' },
  race: { type: 'string' },
  height: { type: 'string' },
  atk: { type: 'string' },
  shield: { type: 'string', description: '护盾值, 战斗中先扣护盾再扣生命, 没有就填 0' },
  hp: { type: 'string' },
  energy: { type: 'string', description: '上场消耗的能量 (0 或空字符串表示不花能量), 与强度相称: 杂兵 1-2, 中坚 2-3, 王牌 4-6' },
  description: { type: 'string', description: '自然语言效果描述' },
  machine_effect: { type: 'object', description: '机读效果对象, 没有则给空对象' },
};

const CARD_REQUIRED = Object.keys(CARD_PROPERTIES);

const 机读输出Schema: JsonSchema = {
  name: 'machine_effect_output',
  description: '把卡牌效果翻译成机读效果',
  value: {
    type: 'object',
    properties: {
      machine_effect: { type: 'object', description: '机读效果对象, 确实没有可表达的效果时给空对象 {}' },
      ignored: { type: 'array', items: { type: 'string' }, description: '无法用现有语法表达而省略的效果' },
    },
    required: ['machine_effect', 'ignored'],
    additionalProperties: false,
  },
};

const 卡牌输出Schema: JsonSchema = {
  name: 'card_output',
  description: '一张完整的卡牌',
  value: {
    type: 'object',
    properties: CARD_PROPERTIES,
    required: CARD_REQUIRED,
    additionalProperties: false,
  },
};

const 卡组输出Schema: JsonSchema = {
  name: 'deck_output',
  description: '一套敌方卡组',
  value: {
    type: 'object',
    properties: {
      名称: { type: 'string', description: '卡组名称' },
      备注: { type: 'string', description: '设计思路, 一句话' },
      卡牌: {
        type: 'array',
        items: {
          type: 'object',
          properties: { ...CARD_PROPERTIES, 数量: { type: 'integer', minimum: 1, maximum: 3 } },
          required: [...CARD_REQUIRED, '数量'],
          additionalProperties: false,
        },
      },
    },
    required: ['名称', '备注', '卡牌'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// 1. 写机读
// ---------------------------------------------------------------------------

export interface 写机读结果 {
  /** 校验通过的机读效果; 卡牌确实没有机读效果时为 undefined */
  machine_effect?: Record<string, any>;
  /** 被省略、无法表达的效果说明 */
  ignored: string[];
  /** 非空表示失败 (AI 没返回或校验始终不通过) */
  error: string;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}

/** 从模型返回里取出机读效果对象 (兼容 { machine_effect: {...} } 与直接给对象两种写法) */
function pickMachineEffect(parsed: unknown): Record<string, any> | undefined {
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  const inner = parsed.machine_effect;
  if (isPlainObject(inner)) {
    return inner;
  }
  return parsed;
}

/** 让 AI 根据校验错误修正机读效果, 返回修正后的对象 (可能仍不合法, 由调用方再校验) */
async function repairMachineEffect(context: string, bad_effect: unknown, error: string): Promise<Record<string, any> | undefined> {
  const text = await aiGenerate({
    system: [用户优先规范, 机读规范, 输出约定].join('\n\n'),
    context: [
      context,
      '【上一版机读效果 (校验失败)】',
      JSON.stringify(bad_effect, null, 2),
      '【校验错误信息】',
      error,
    ].join('\n'),
    prompt: '请修正上面的机读效果, 只输出修正后的机读效果 JSON 对象 (不要外层包装, 不要解释).',
  });
  return pickMachineEffect(parseAiJson(text));
}

/**
 * 把一张卡牌的自然语言效果翻译成机读效果.
 *
 * @param card 卡牌 (读取卡名/类型/数值/效果描述)
 * @param 说明 作者补充说明 (例如「只做常驻修正」)
 */
export async function 写机读(card: Card, 说明 = ''): Promise<写机读结果> {
  const system = [promptText('用户优先'), promptText('机读规范'), promptText('输出约定'), promptText('机读任务')]
    .filter(Boolean)
    .join('\n\n');

  const context = [
    '【卡牌】',
    describeCard(card),
    说明.trim() ? `【作者补充说明】\n${说明.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const first = await aiGenerateJson<Record<string, unknown>>({
    system,
    context,
    prompt: '请输出这张卡的机读效果 JSON.',
    json_schema: 机读输出Schema,
  });

  const ignored = toStringArray(first?.ignored);
  let effect = pickMachineEffect(first);
  if (!effect || Object.keys(effect).length === 0) {
    return { ignored, error: '' };
  }

  let error = parseMachineEffect(effect).error;
  if (error) {
    const repaired = await repairMachineEffect(context, effect, error);
    if (repaired) {
      effect = repaired;
      error = parseMachineEffect(effect).error;
    }
  }
  if (error) {
    return { ignored, error: `机读效果校验失败: ${error}` };
  }
  return { machine_effect: effect, ignored, error: '' };
}

// ---------------------------------------------------------------------------
// 2. 生成卡牌
// ---------------------------------------------------------------------------

export interface 生成卡牌参数 {
  阵营: CardFaction;
  /** 用户想要什么样的卡 (自然语言) */
  需求: string;
  /** 可选的参考卡, 用来对齐风格与数值 */
  参考卡?: Card | null;
  /** 是否把最近的聊天记录一起发给 AI (默认不带) */
  带入上下文?: boolean;
  /** 带入上下文时的聊天条数, 默认 30 */
  历史条数?: number;
}

export interface 生成卡牌结果 {
  card: AiCardDraft;
  /** 机读效果被丢弃等警告 */
  warnings: string[];
}

/** 把聊天条数限制在合理范围内 (1-200) */
function clampHistory(历史条数: number | undefined, fallback: number): number {
  return Math.min(Math.max(Math.trunc(历史条数 ?? fallback) || fallback, 1), 200);
}

/** 构造「生成一张卡」的请求 (纯函数, 便于测试) */
export function 卡牌请求(params: 生成卡牌参数): AiRequest {
  const { 阵营, 需求, 参考卡, 带入上下文 = false, 历史条数 } = params;
  const history = 带入上下文 ? clampHistory(历史条数, 30) : 0;

  const system = [
    promptText('用户优先'),
    promptText('卡牌规范'),
    promptText('机读规范'),
    promptText('输出约定'),
    history > 0 ? '你会看到最近的聊天记录, 可以让这张卡贴合当前剧情.' : '',
    promptText('卡牌任务'),
  ]
    .filter(Boolean)
    .join('\n\n');

  const context = [
    `【目标阵营】${阵营}`,
    需求.trim() ? `【需求 (最高优先级)】\n${需求.trim()}` : '【需求】\n自由发挥, 设计一张有特点的卡',
    参考卡 ? `【参考卡 (对齐风格与数值, 不要照抄; 用户另有要求时以用户为准)】\n${describeCard(参考卡)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    system,
    context,
    prompt: '请输出这张卡的 JSON.',
    json_schema: 卡牌输出Schema,
    ...(history > 0 ? { with_history: true, max_chat_history: history } : {}),
  };
}

/** 生成一张新卡 */
export async function 生成卡牌(params: 生成卡牌参数): Promise<生成卡牌结果> {
  const { 阵营 } = params;
  const raw = await aiGenerateJson<unknown>(卡牌请求(params));
  const card = normalizeAiCard(raw, 阵营);
  const warnings: string[] = [];

  if (card.machine_effect != null) {
    let error = parseMachineEffect(card.machine_effect).error;
    if (error) {
      const repaired = await repairMachineEffect(`【卡牌】\n${describeCard(card)}`, card.machine_effect, error);
      if (repaired && !parseMachineEffect(repaired).error) {
        card.machine_effect = repaired;
        error = null;
      }
    }
    if (error) {
      warnings.push(`机读效果校验失败, 已丢弃: ${error}`);
      delete card.machine_effect;
    }
  }

  return { card, warnings };
}

// ---------------------------------------------------------------------------
// 3. 生成卡组 (新建 / 往已有卡组里补充)
// ---------------------------------------------------------------------------

export interface 生成卡组参数 {
  /** 新卡的阵营 (追加模式下一般用目标卡组的阵营) */
  阵营: CardFaction;
  /**
   * 生成的卡牌存成哪个阵营 (默认跟随卡组阵营).
   * 传「通用」时卡组仍属于 阵营, 但卡牌双方都能使用.
   */
  卡牌阵营?: CardFaction;
  /** 对手卡组, 用于评估强度、决定配比 (可省略) */
  参考卡组?: Card[];
  /** 已有卡组内容: 非空时表示「在这套卡的基础上补充新卡」 */
  已有卡组?: Card[];
  /** 用户的修正指示 (例如「再强一点」「多来点陷阱」) */
  需求?: string;
  /** 期望新增的卡牌张数, 默认 20 */
  张数?: number;
  /** 是否把最近的聊天记录一起发给 AI (默认带) */
  带入上下文?: boolean;
  /** 带入上下文时的聊天条数, 默认 30 */
  历史条数?: number;
}

export interface 生成卡组结果 {
  名称: string;
  备注: string;
  卡牌: AiCardDraft[];
  warnings: string[];
}

/** 构造「生成卡组」的请求 (纯函数, 便于测试) */
export function 卡组请求(params: 生成卡组参数): AiRequest {
  const {
    阵营,
    卡牌阵营 = 阵营,
    参考卡组 = [],
    已有卡组 = [],
    需求 = '',
    张数 = 20,
    带入上下文 = true,
    历史条数,
  } = params;
  const count = Math.min(Math.max(Math.trunc(张数) || 20, 1), 40);
  const append = 已有卡组.length > 0;
  const history = 带入上下文 ? clampHistory(历史条数, 30) : 0;

  const system = [
    promptText('用户优先'),
    promptText('卡牌规范'),
    promptText('机读规范'),
    promptText('输出约定'),
    history > 0 ? '你会看到最近的聊天记录, 请让卡牌贴合当前剧情 (角色、世界观、正在发生的事), 而不是通用杂兵.' : '',
    append
      ? '这套卡组已经有一部分卡了, 请在此基础上补充新卡: 不要重复已有卡牌的定位与效果, 优先补齐它的短板.'
      : '请从零设计一整套卡组.',
    参考卡组.length > 0
      ? '同时参考对手卡组的强度与构成, 让战斗有来有回: 对手强则略强或克制, 对手弱则略弱. (这只是默认建议, 用户有要求时以用户为准)'
      : '',
    promptTextFilled('卡组任务', {
      阵营,
      卡牌阵营: `${卡牌阵营}${卡牌阵营 === '通用' ? ' (双方都能使用)' : ''}`,
      方式: append ? '新增' : '',
      张数: count,
    }),
  ]
    .filter(Boolean)
    .join('\n\n');

  const context = [
    已有卡组.length > 0 ? `【已有卡组 (需要补充的这套)】\n${describeDeck(已有卡组)}` : '',
    参考卡组.length > 0 ? `【对手卡组 (强度参考)】\n${describeDeck(参考卡组)}` : '',
    需求.trim() ? `【用户要求 (最高优先级)】\n${需求.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    system,
    context,
    prompt: `请输出一套 ${count} 张左右的${阵营}卡组 JSON.`,
    json_schema: 卡组输出Schema,
    ...(history > 0 ? { with_history: true, max_chat_history: history } : {}),
  };
}

/** 依据聊天上下文与参考卡组强度, 生成一套卡组 (或为已有卡组补充新卡) */
export async function 生成卡组(params: 生成卡组参数): Promise<生成卡组结果> {
  const { 阵营, 卡牌阵营 = 阵营, 张数 = 20 } = params;
  const count = Math.min(Math.max(Math.trunc(张数) || 20, 1), 40);

  const raw = await aiGenerateJson<unknown>(卡组请求(params));
  const deck = normalizeAiDeck(raw, 卡牌阵营, { limit: count + 10 });
  const warnings = [...deck.warnings];

  // 机读效果逐张校验; 不合法的只丢弃机读区, 保留卡牌本身
  for (const card of deck.卡牌) {
    if (card.machine_effect == null) {
      continue;
    }
    const { error } = parseMachineEffect(card.machine_effect);
    if (error) {
      warnings.push(`「${card.name}」机读效果无效, 已丢弃: ${error}`);
      delete card.machine_effect;
    }
  }

  return { 名称: deck.名称, 备注: deck.备注, 卡牌: deck.卡牌, warnings };
}
