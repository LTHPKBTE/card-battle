// 卡牌内容指纹 (去重用)
//
// AI 生成的卡组里, 「一张卡携带多份」会展开成多条一模一样的卡牌草稿.
// 写入卡牌库时应该只建一张卡, 卡组里用同一个 id 重复出现来表示份数;
// 否则卡牌库会被内容完全相同、只是 id 不同的卡塞满.
//
// 本模块不依赖酒馆注入的全局变量, 可以在 node 里直接跑测试.

/** 能参与「内容是否相同」比较的卡牌 (卡牌库的 Card 与 AI 生成的草稿都满足) */
export interface ContentComparableCard {
  /** 以下字段都不参与比较, 仅为了能直接传整张卡而不触发多余属性检查 */
  id?: unknown;
  阵营?: unknown;
  created_at?: unknown;

  name?: string | null;
  series?: string | null;
  rarity?: string | null;
  stars?: unknown;
  type?: string | null;
  attribute?: string | null;
  gender?: string | null;
  race?: string | null;
  height?: string | null;
  atk?: string | null;
  shield?: string | null;
  hp?: string | null;
  energy?: string | null;
  description?: string | null;
  machine_effect?: unknown;
}

/** 参与比较的字段 (顺序固定, 便于生成稳定的指纹) */
const CONTENT_FIELDS = [
  'name',
  'series',
  'rarity',
  'stars',
  'type',
  'attribute',
  'gender',
  'race',
  'height',
  'atk',
  'shield',
  'hp',
  'energy',
  'description',
] as const satisfies readonly (keyof ContentComparableCard)[];

/** 稳定序列化: 对象的键按字典序排列, 保证同一结构、不同键顺序得到同一个字符串 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/**
 * 计算一张卡牌的「内容指纹」: 内容完全相同的卡牌会得到同一个字符串.
 *
 * 不含 id / created_at / 阵营, 因此同一张卡的不同副本、以及分属不同阵营的复制品
 * 都会被认成同一内容; 文本字段首尾空白不影响结果.
 */
export function cardContentKey(card: ContentComparableCard): string {
  const parts = CONTENT_FIELDS.map(field => {
    const value = card[field];
    return `${field}=${value === null || value === undefined ? '' : String(value).trim()}`;
  });
  const machine = card.machine_effect;
  parts.push(`machine_effect=${machine === null || machine === undefined ? '' : stableStringify(machine)}`);
  return parts.join('\u0001');
}

/**
 * 按内容指纹给一批卡牌建索引: 同一内容只记住第一个出现的 id.
 * 用于「生成卡组时优先复用卡牌库里已有的相同卡牌」.
 */
export function indexCardsByContent(cards: (ContentComparableCard & { id: string })[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const card of cards) {
    const key = cardContentKey(card);
    if (!index.has(key)) {
      index.set(key, card.id);
    }
  }
  return index;
}
