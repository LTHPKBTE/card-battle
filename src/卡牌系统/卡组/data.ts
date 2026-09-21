// 卡组数据访问层: 以 "聊天变量 (chat)" 为存储, 命名空间 `卡组`
// - 卡组只存卡牌 id, 需要完整信息时从卡牌库 (角色卡变量) 读取
// - 出战时把完整卡牌快照写入聊天变量 `战斗.出战卡组`
import { uuidv4 } from '@util/common';
import { createCard, loadCard, loadCards } from '../卡牌/data';
import { cardContentKey, indexCardsByContent } from '../卡牌/去重';
import type { Card, CardInput } from '../卡牌/schema';
import {
  BATTLE_CHAT_KEY,
  DECK_CHAT_KEY,
  DECK_VERSION,
  DEPLOYED_DECK_KEY,
  DeployedDeckSchema,
  DeckSchema,
  DeckStoreSchema,
  type Deck,
  type DeckFaction,
  type DeckInput,
  type DeckStore,
  type DeployedDeck,
} from './schema';

/**
 * 存储格式迁移表: 键为「从该版本号迁移到下一个版本」的迁移函数.
 * 升级流程同卡牌库: schema.ts 里 DECK_VERSION +1, 在此登记迁移函数.
 */
const migrations: Record<number, (store: Record<string, any>) => Record<string, any>> = {
  // 1 -> 2: 新增「阵营」字段 (我方 / 敌方), 旧卡组统一归为「我方」
  1: store => {
    const decks = _.isPlainObject(store.卡组) ? (store.卡组 as Record<string, any>) : {};
    for (const deck of Object.values(decks)) {
      if (_.isPlainObject(deck) && !deck.阵营) {
        deck.阵营 = '我方';
      }
    }
    return { ...store, 版本: 2 };
  },
};

/** 只按版本表迁移原始数据, 不做 schema 解析 */
function migrateRaw(raw: unknown): Record<string, any> {
  let store: Record<string, any> = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
  let version = Number(_.get(store, '版本')) || 1;
  while (version < DECK_VERSION) {
    const migrate = migrations[version];
    if (!migrate) {
      break;
    }
    store = migrate(store);
    version = Number(_.get(store, '版本')) || version + 1;
  }
  return store;
}

/** 判断当前是否已进入某个对话 (聊天变量在欢迎页不存在) */
export function hasChat(): boolean {
  try {
    return Boolean(SillyTavern.getCurrentChatId());
  } catch {
    return false;
  }
}

/** 读取卡组存储 (缺失/无聊天时返回空存储, 并按版本迁移) */
export function loadDeckStore(): DeckStore {
  if (!hasChat()) {
    return DeckStoreSchema.parse({});
  }
  try {
    return DeckStoreSchema.parse(migrateRaw(_.get(getVariables({ type: 'chat' }), DECK_CHAT_KEY)));
  } catch {
    return DeckStoreSchema.parse({});
  }
}

/** 写回卡组存储 */
function saveDeckStore(store: DeckStore): void {
  updateVariablesWith(
    variables => {
      _.set(variables, DECK_CHAT_KEY, DeckStoreSchema.parse(store));
      return variables;
    },
    { type: 'chat' },
  );
}

/** 读取全部卡组 (按创建时间/插入顺序) */
export function loadDecks(): Deck[] {
  return _.values(loadDeckStore().卡组);
}

/** 读取指定阵营的卡组 */
export function loadDecksByFaction(faction: DeckFaction): Deck[] {
  return loadDecks().filter(deck => deck.阵营 === faction);
}

/** 依据 id 读取卡组 */
export function loadDeck(deck_id: string): Deck | undefined {
  return loadDeckStore().卡组[deck_id];
}

/** 新增或覆盖一个卡组 */
export function saveDeck(deck: DeckInput): Deck {
  const parsed = DeckSchema.parse(deck);
  const store = loadDeckStore();
  store.卡组[parsed.id] = parsed;
  saveDeckStore(store);
  return parsed;
}

/** 新建一个空卡组并写入, 返回新卡组 */
export function createDeck(名称 = '', 阵营: DeckFaction = '我方'): Deck {
  const deck = DeckSchema.parse({
    id: uuidv4(),
    名称,
    阵营,
    卡牌: [],
    备注: '',
    创建时间: Date.now(),
  });
  return saveDeck(deck);
}

/** 删除卡组; 若它是当前出战卡组则同时清空出战记录 */
export function deleteDeck(deck_id: string): boolean {
  const store = loadDeckStore();
  if (!_.has(store.卡组, deck_id)) {
    return false;
  }
  delete store.卡组[deck_id];
  if (store.出战卡组 === deck_id) {
    store.出战卡组 = '';
  }
  saveDeckStore(store);
  if (loadDeployedDeck()?.卡组id === deck_id) {
    clearDeployedDeck();
  }
  return true;
}

/** 往卡组里加入一张卡牌 (追加一份) */
export function addCardToDeck(deck_id: string, card_id: string): Deck | undefined {
  const deck = loadDeck(deck_id);
  if (!deck) {
    return undefined;
  }
  deck.卡牌.push(card_id);
  return saveDeck(deck);
}

/**
 * 设置某张卡牌在卡组中的份数.
 * 保持该卡牌在列表中原有位置 (取首次出现的位置), 份数为 0 时移除.
 */
export function setCardCount(deck_id: string, card_id: string, count: number): Deck | undefined {
  const deck = loadDeck(deck_id);
  if (!deck) {
    return undefined;
  }
  const target = Math.max(0, Math.trunc(count));
  const first_index = deck.卡牌.indexOf(card_id);
  const others = deck.卡牌.filter(id => id !== card_id);
  if (target > 0) {
    const insert_at = first_index < 0 ? others.length : Math.min(first_index, others.length);
    others.splice(insert_at, 0, ...Array.from({ length: target }, () => card_id));
  }
  deck.卡牌 = others;
  return saveDeck(deck);
}

/** 取一个不与现有卡组重名的名称 */
function uniqueDeckName(base: string): string {
  const names = new Set(loadDecks().map(deck => deck.名称?.trim()).filter(Boolean));
  if (!names.has(base)) {
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base} ${index}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
  return `${base} ${Date.now()}`;
}

/** 复制卡组到另一个阵营时的选项 */
export interface 复制卡组选项 {
  /** 新卡组所属阵营 */
  目标阵营: DeckFaction;
  /** 只有原阵营能用的卡牌怎么处理: 忽略, 或复制一份目标阵营的卡牌 */
  单向卡: 'ignore' | 'copy';
  /** 新卡组名称, 省略时用「原名称 (副本)」 */
  名称?: string;
}

export interface 复制卡组结果 {
  卡组: Deck;
  /** 被忽略的卡牌 (同内容只列一次) */
  忽略: Card[];
  /** 为原阵营卡牌复制出来的目标阵营卡牌 (同内容只列一次) */
  复制: Card[];
  /** 已不在卡牌库里的卡牌份数 */
  缺失: number;
}

/**
 * 把一个卡组复制成另一个阵营的卡组.
 *
 * - 「通用」卡与目标阵营的卡直接沿用原来的 id
 * - 只有原阵营能用的卡: 按 `单向卡` 选择忽略, 或复制一份目标阵营的卡牌
 *   (内容与卡牌库中已有的相同卡一致时直接复用, 不重复入库)
 */
export function 复制卡组(deck_id: string, 选项: 复制卡组选项): 复制卡组结果 {
  const source = loadDeck(deck_id);
  if (!source) {
    throw new Error('卡组不存在');
  }

  const target = 选项.目标阵营;
  const ids: string[] = [];
  const 忽略: Card[] = [];
  const 复制: Card[] = [];
  const ignored_ids = new Set<string>();
  const copied_ids = new Set<string>();
  let 缺失 = 0;

  // 内容相同的目标阵营卡牌直接复用, 不重复入库
  const reusable = indexCardsByContent(loadCards().filter(card => card.阵营 === '通用' || card.阵营 === target));

  for (const card_id of source.卡牌) {
    const card = loadCard(card_id);
    if (!card) {
      缺失 += 1;
      continue;
    }
    if (card.阵营 === '通用' || card.阵营 === target) {
      ids.push(card.id);
      continue;
    }

    if (选项.单向卡 === 'ignore') {
      if (!ignored_ids.has(card.id)) {
        ignored_ids.add(card.id);
        忽略.push(card);
      }
      continue;
    }

    const { id: _id, created_at: _created_at, ...rest } = card;
    const content = { ...rest, 阵营: target } as Partial<CardInput>;
    const key = cardContentKey(content);
    let new_id = reusable.get(key);
    if (!new_id) {
      const created = createCard(content);
      reusable.set(key, created.id);
      new_id = created.id;
      if (!copied_ids.has(new_id)) {
        copied_ids.add(new_id);
        复制.push(created);
      }
    } else if (!copied_ids.has(new_id)) {
      copied_ids.add(new_id);
      复制.push({ ...card, id: new_id, 阵营: target });
    }
    ids.push(new_id);
  }

  const base_name = 选项.名称?.trim() || `${source.名称?.trim() || '未命名卡组'} (副本)`;
  const deck = createDeck(uniqueDeckName(base_name), target);
  const saved = saveDeck({ ...deck, 卡牌: ids, 备注: source.备注 });
  return { 卡组: saved, 忽略, 复制, 缺失 };
}

/** 卡组内容中的一行 (同一张卡牌合并为份数) */
export interface DeckCardRow {
  card_id: string;
  /** 卡牌库中的完整信息; 卡牌已从卡牌库删除时为 undefined */
  card: Card | undefined;
  /** 份数 */
  count: number;
}

/** 把卡组的 id 列表合并为「卡牌 + 份数」的行, 顺序按首次出现位置 */
export function groupDeckCards(deck: Deck): DeckCardRow[] {
  const counts = new Map<string, number>();
  for (const card_id of deck.卡牌) {
    counts.set(card_id, (counts.get(card_id) ?? 0) + 1);
  }
  return [...counts.entries()].map(([card_id, count]) => ({
    card_id,
    card: loadCard(card_id),
    count,
  }));
}

/** 解析卡组为完整卡牌列表 (重复份数展开), 并给出卡牌库中已不存在的 id */
export function resolveDeck(deck: Deck): { 卡牌: Card[]; 缺失: string[] } {
  const 卡牌: Card[] = [];
  const 缺失: string[] = [];
  for (const card_id of deck.卡牌) {
    const card = loadCard(card_id);
    if (card) {
      卡牌.push(card);
    } else if (!缺失.includes(card_id)) {
      缺失.push(card_id);
    }
  }
  return { 卡牌, 缺失 };
}

/**
 * 让某个卡组出战: 把完整卡牌快照写入聊天变量 `战斗.出战卡组`,
 * 并在卡组存储里记下出战卡组 id.
 */
export function deployDeck(deck_id: string): { deployed: DeployedDeck; 缺失: string[] } {
  const deck = loadDeck(deck_id);
  if (!deck) {
    throw new Error('卡组不存在');
  }
  const { 卡牌, 缺失 } = resolveDeck(deck);
  const deployed = DeployedDeckSchema.parse({
    卡组id: deck.id,
    名称: deck.名称,
    备注: deck.备注,
    卡牌,
    选择时间: new Date().toISOString(),
  });
  updateVariablesWith(
    variables => {
      _.set(variables, `${BATTLE_CHAT_KEY}.${DEPLOYED_DECK_KEY}`, deployed);
      return variables;
    },
    { type: 'chat' },
  );
  const store = loadDeckStore();
  store.出战卡组 = deck.id;
  saveDeckStore(store);
  return { deployed, 缺失 };
}

/** 读取当前出战卡组快照 (未出战时返回 undefined) */
export function loadDeployedDeck(): DeployedDeck | undefined {
  if (!hasChat()) {
    return undefined;
  }
  try {
    const raw = _.get(getVariables({ type: 'chat' }), `${BATTLE_CHAT_KEY}.${DEPLOYED_DECK_KEY}`);
    if (raw === undefined || raw === null) {
      return undefined;
    }
    return DeployedDeckSchema.parse(raw);
  } catch {
    return undefined;
  }
}

/** 取消出战 (删除聊天变量 `战斗.出战卡组`) */
export function clearDeployedDeck(): void {
  updateVariablesWith(
    variables => {
      _.unset(variables, `${BATTLE_CHAT_KEY}.${DEPLOYED_DECK_KEY}`);
      return variables;
    },
    { type: 'chat' },
  );
  const store = loadDeckStore();
  if (store.出战卡组) {
    store.出战卡组 = '';
    saveDeckStore(store);
  }
}

/** 卡牌库中是否已有卡牌 (没有卡牌时卡组没有内容可选) */
export function hasCards(): boolean {
  try {
    return loadCards().length > 0;
  } catch {
    return false;
  }
}
