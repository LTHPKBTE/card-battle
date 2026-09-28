// 卡牌库数据访问层: 数据可以放在三个层级 (聊天 / 角色卡 / 全局)
// - 读取时把三层合并 (小范围覆盖大范围), 面板看到的是「这一份数据里可用的全部卡牌」
// - 写入时写回卡牌「住」的那一层 (新建的卡牌写进位置偏好里选的那一层)
// - 层级的读写细节在 ../共用/层级.ts
import { literalYamlify, uuidv4 } from '../共用/平台';
import {
  DATA_LAYERS,
  availableLayers,
  mergeLayers,
  preferredLayer,
  readLayer,
  writeLayer,
  deleteLayerKey,
  type DataLayer,
  type Layered,
} from '../共用/层级';
import {
  CARD_LIBRARY_KEY,
  CARD_LIBRARY_VERSION,
  CardLibrarySchema,
  CardSchema,
  parseLegacyStars,
  type Card,
  type CardFaction,
  type CardInput,
  type CardLibrary,
} from './schema';

/**
 * 存储格式迁移表: 键为「从该版本号迁移到下一个版本」的迁移函数.
 *
 * 未来升级格式时, 例如要让结构从版本 N 升级到 N+1:
 *  1. 在 schema.ts 中将 CARD_LIBRARY_VERSION 改为 N+1;
 *  2. 在此登记 `N: library => ({ ...library, 版本: N+1, ...迁移字段 })`;
 *  3. 旧数据会在 loadLibrary / 导入时自动逐步迁移到最新版本, 无需手动处理.
 */
const migrations: Record<number, (library: Record<string, any>) => Record<string, any>> = {
  // 1 -> 2: stars 由自由文本 ("★★★" / "★ x3") 改为 0-8 的星数;
  //        顺带清理旧版自动保存把「清空的机读区」误存成的 null.
  1: library => {
    const cards = _.isPlainObject(library.卡牌) ? (library.卡牌 as Record<string, any>) : {};
    for (const card of Object.values(cards)) {
      if (!_.isPlainObject(card)) {
        continue;
      }
      card.stars = parseLegacyStars(card.stars);
      if (card.machine_effect === null) {
        delete card.machine_effect;
      }
    }
    return { ...library, 版本: 2 };
  },
  // 2 -> 3: 新增「阵营」字段 (通用 / 我方 / 敌方), 旧卡统一归为「通用」
  2: library => {
    const cards = _.isPlainObject(library.卡牌) ? (library.卡牌 as Record<string, any>) : {};
    for (const card of Object.values(cards)) {
      if (_.isPlainObject(card) && !card.阵营) {
        card.阵营 = '通用';
      }
    }
    return { ...library, 版本: 3 };
  },
  // 3 -> 4: 旧字段 def (防御力) 改名为 shield (护盾), 数值照搬 —— 盾从「只展示」变成「真能挡伤害」
  3: library => {
    const cards = _.isPlainObject(library.卡牌) ? (library.卡牌 as Record<string, any>) : {};
    for (const card of Object.values(cards)) {
      if (!_.isPlainObject(card)) {
        continue;
      }
      if (card.shield === undefined && card.def !== undefined) {
        card.shield = card.def;
      }
      delete card.def;
    }
    return { ...library, 版本: 4 };
  },
};

/**
 * 只按版本表迁移原始数据, 不做 schema 解析.
 * 供「导入时先迁移旧字段 (如 stars 文本) 再逐张校验」使用.
 */
function migrateRaw(raw: unknown): Record<string, any> {
  let library: Record<string, any> = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
  let version = Number(_.get(library, '版本')) || 1;
  while (version < CARD_LIBRARY_VERSION) {
    const migrate = migrations[version];
    if (!migrate) {
      // 缺少迁移函数时停止, 交由 schema 兜底解析 (尽量保留已有卡牌)
      break;
    }
    library = migrate(library);
    version = Number(_.get(library, '版本')) || version + 1;
  }
  return library;
}

/**
 * 将任意版本/结构的库数据迁移到当前版本并解析.
 * 缺失 `版本` 字段的旧数据视为版本 1.
 */
export function migrateLibrary(raw: unknown): CardLibrary {
  return CardLibrarySchema.parse(migrateRaw(raw));
}

/** 读取某一层里的卡牌库 (该层没有数据时是空库) */
export function loadLayerLibrary(layer: DataLayer): CardLibrary {
  return migrateLibrary(readLayer(layer, CARD_LIBRARY_KEY));
}

/** 三层各自的卡牌记录 (按 id) */
export function loadLayerRecords(): Partial<Record<DataLayer, Record<string, Card>>> {
  const records: Partial<Record<DataLayer, Record<string, Card>>> = {};
  for (const layer of DATA_LAYERS) {
    records[layer] = loadLayerLibrary(layer).卡牌;
  }
  return records;
}

/** 合并三层后的卡牌: id → { 卡牌, 来自哪一层 } */
export function loadCardLayers(): Map<string, Layered<Card>> {
  return mergeLayers(loadLayerRecords());
}

/**
 * 读取卡牌库整体数据 (三层合并的结果).
 * 返回的结构与原格式一致, 但 `版本` 总是当前版本 (各层写入时各自迁移并落盘).
 */
export function loadLibrary(): CardLibrary {
  return CardLibrarySchema.parse({
    版本: CARD_LIBRARY_VERSION,
    卡牌: Object.fromEntries([...loadCardLayers()].map(([id, hit]) => [id, hit.value])),
  });
}

/** 读取全部卡牌, 返回副本数组 (顺序按记录插入顺序, 与 UI 排序无关) */
export function loadCards(): Card[] {
  return [...loadCardLayers().values()].map(hit => hit.value);
}

/** 这张卡「住」在哪一层; 不存在的卡返回 null */
export function cardLayer(card_id: string): DataLayer | null {
  return loadCardLayers().get(card_id)?.layer ?? null;
}

/**
 * 读取指定阵营可用的卡牌: 「通用」卡在任意阵营都返回, 该阵营专属卡只在本阵营返回.
 * `faction` 传空字符串时返回全部卡牌.
 */
export function loadCardsByFaction(faction: CardFaction | ''): Card[] {
  const cards = loadCards();
  if (!faction) {
    return cards;
  }
  return cards.filter(card => card.阵营 === '通用' || card.阵营 === faction);
}

/** 依据 id 读取一张卡牌; 不存在时返回 undefined */
export function loadCard(card_id: string): Card | undefined {
  return loadCardLayers().get(card_id)?.value;
}

/** 写入某一层里的单张卡牌 (内部用) */
function writeCardToLayer(card: Card, layer: DataLayer): void {
  const library = loadLayerLibrary(layer);
  library.版本 = CARD_LIBRARY_VERSION;
  library.卡牌[card.id] = card;
  writeLayer(layer, CARD_LIBRARY_KEY, CardLibrarySchema.parse(library));
}

/**
 * 写入单张卡牌 (新增或覆盖), 保存前按 schema 校验.
 *
 * `layer` 省略时写回这张卡原本所在的层 (不填就不会把一张全局卡偷偷搬进当前聊天);
 * 是一张新卡时才落到位置偏好里选的层.
 */
export function saveCard(card: CardInput, layer?: DataLayer): void {
  const parsed = CardSchema.parse(card);
  // 机读区为空时彻底移除该键, 避免被存成 null
  if (parsed.machine_effect == null) {
    delete parsed.machine_effect;
  }
  writeCardToLayer(parsed, layer ?? cardLayer(parsed.id) ?? preferredLayer());
}

/** 新建一张卡牌并立即写回, 返回写回后的完整卡牌 */
export function createCard(partial?: Partial<CardInput>, layer?: DataLayer): Card {
  const card = CardSchema.parse({
    id: uuidv4(),
    name: '',
    type: '从者',
    rarity: 'N',
    ...partial,
  });
  card.created_at = Date.now();
  saveCard(card, layer ?? preferredLayer());
  return card;
}

/** 删除一张卡牌 (从它所在的那一层删), 返回是否实际删除 */
export function deleteCardById(card_id: string): boolean {
  const layer = cardLayer(card_id);
  if (!layer) {
    return false;
  }
  deleteLayerKey(layer, `${CARD_LIBRARY_KEY}.卡牌.${card_id}`);
  return true;
}

/**
 * 把卡牌写入指定位置 (供迁移用).
 *
 * - `复制`: 在目标层生成一份独立副本 (新 id), 两边之后互不影响;
 * - `移动`: 先写进目标层, 再从原层移除 (同一张卡只会在一个地方).
 *
 * 返回写回去的卡牌 (复制时是新 id 的那一份) 与产生的新 id 映射.
 */
export function migrateCards(
  card_ids: string[],
  to: DataLayer,
  mode: 'move' | 'copy',
): { 写入: Card[]; 新id: Record<string, string> } {
  const 写入: Card[] = [];
  const 新id: Record<string, string> = {};
  for (const card_id of card_ids) {
    const hit = loadCardLayers().get(card_id);
    if (!hit) {
      continue;
    }
    if (mode === 'move') {
      if (hit.layer === to) {
        continue;
      }
      writeCardToLayer(hit.value, to);
      // 先在目标层落盘再删原层: 中途出错也只会多一份, 不会丢
      deleteLayerKey(hit.layer, `${CARD_LIBRARY_KEY}.卡牌.${card_id}`);
      写入.push(hit.value);
      continue;
    }
    // 复制: 副本是独立的一张卡 (自己的 id), 之后改哪一边都不会影响另一边
    const copy = CardSchema.parse({ ...hit.value, id: uuidv4() });
    writeCardToLayer(copy, to);
    新id[card_id] = copy.id;
    写入.push(copy);
  }
  return { 写入, 新id };
}

// ---- 导出 / 导入 ----

/**
 * 取某些卡牌 (不传就取全部) 的完整信息; 传空数组表示一张都不要.
 *
 * 供「只导出选中的卡牌」以及「导出卡组时把用到的卡牌一并带上」使用 ——
 * 别人的卡牌库里没有这些 id 时, 卡组会出现一堆「已不在卡牌库」.
 * 顺序按卡牌库的插入顺序 (也就是面板看到的顺序), 导出文件读起来才顺.
 */
export function exportCards(card_ids?: readonly string[]): Card[] {
  const cards = loadCards();
  if (card_ids === undefined) {
    return cards;
  }
  const wanted = new Set(card_ids);
  return cards.filter(card => wanted.has(card.id));
}

/** 批量写入的统计 */
export interface WriteCardsResult {
  /** 新增的卡牌数 */
  新增: number;
  /** 覆盖 (同 id 已存在) 的卡牌数 */
  覆盖: number;
}

/** 把一批卡牌写入某一层 (同 id 覆盖, 其余新增); 合并导入与备份恢复都用它 */
export function writeCards(cards: readonly Card[], layer: DataLayer): WriteCardsResult {
  const existing = loadLayerLibrary(layer).卡牌;
  let 新增 = 0;
  let 覆盖 = 0;
  for (const card of cards) {
    if (_.has(existing, card.id)) {
      覆盖 += 1;
    } else {
      新增 += 1;
    }
    writeCardToLayer(card, layer);
  }
  return { 新增, 覆盖 };
}

/** 清空某一层的卡牌库 (只删本脚本自己的命名空间, 不动这一层的其他数据) */
export function clearCardLayer(layer: DataLayer): void {
  deleteLayerKey(layer, CARD_LIBRARY_KEY);
}

/** 能在哪些位置放卡牌 (供面板的位置选择器列出) */
export function cardLayers(): DataLayer[] {
  return availableLayers();
}

/** 机读效果对象 -> YAML 文本 (供编辑器显示) */
export function machineEffectToYaml(machine_effect: unknown): string {
  if (machine_effect === undefined || machine_effect === null) {
    return '';
  }
  return literalYamlify(machine_effect).trimEnd();
}

/**
 * YAML 文本 -> 机读效果对象
 * 空文本 -> undefined; 文本必须能解析为一个 YAML 对象 (不允许标量/数组)
 */
export function machineEffectFromYaml(text: string): { ok: true; value?: Record<string, any> } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }
  let value: unknown;
  try {
    value = YAML.parse(trimmed, { merge: true });
  } catch (error) {
    // 只取首行, 避免把解析器的多行上下文/调用栈暴露给玩家
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.split('\n')[0].trim() || '格式不正确' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '需要一个键值对' };
  }
  return { ok: true, value: value as Record<string, any> };
}

/**
 * 判断当前是否已进入某张角色卡的聊天 (欢迎页/临时聊天等未进入任何角色卡时为 false).
 * 注意: 不能只用 getVariables 探测 —— 欢迎页上读取角色卡变量并不会抛错, 只会返回空对象,
 * 会被误判为已进入角色卡, 导致面板在无数据来源时打开成空壳.
 */
export function hasCharacter(): boolean {
  try {
    return Boolean(getCurrentCharacterId());
  } catch {
    // 非常旧的 tavern-helper 没有 getCurrentCharacterId 接口时, 回退为变量读取探测
    try {
      getVariables({ type: 'character' });
      return true;
    } catch {
      return false;
    }
  }
}
