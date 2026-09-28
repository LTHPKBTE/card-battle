// 卡组数据访问层: 数据可以放在三个层级 (聊天 / 角色卡 / 全局)
// - 读取时把三层合并 (小范围覆盖大范围), 面板看到的是「这一份数据里可用的全部卡组」
// - 「出战卡组」只能有一个, 所以按 聊天 > 角色卡 > 全局 依次回退
// - 出战时把完整卡牌快照写入**聊天**变量 `战斗.出战卡组` (战斗总归属于当前对话)
import { uuidv4 } from '../共用/平台';
import {
  DATA_LAYERS,
  availableLayers,
  deleteLayerKey,
  layerAvailable,
  layerRank,
  mergeLayers,
  preferredLayer,
  readLayer,
  writeLayer,
  type DataLayer,
  type Layered,
} from '../共用/层级';
import { cardLayer, createCard, loadCard, loadCards, migrateCards } from '../卡牌/data';
import { cardContentKey, indexCardsByContent } from '../卡牌/去重';
import { cardIssues } from '../卡牌/校验';
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

/** 读取某一层的卡组存储 (该层没有数据时是空存储, 并按版本迁移) */
export function loadLayerDeckStore(layer: DataLayer): DeckStore {
  if (!layerAvailable(layer)) {
    return DeckStoreSchema.parse({});
  }
  try {
    return DeckStoreSchema.parse(migrateRaw(readLayer(layer, DECK_CHAT_KEY)));
  } catch {
    return DeckStoreSchema.parse({});
  }
}

/** 写回某一层的卡组存储 */
function saveLayerDeckStore(layer: DataLayer, store: DeckStore): void {
  writeLayer(layer, DECK_CHAT_KEY, DeckStoreSchema.parse(store));
}

/** 三层各自的卡组记录 (按 id) */
export function loadDeckLayerRecords(): Partial<Record<DataLayer, Record<string, Deck>>> {
  const records: Partial<Record<DataLayer, Record<string, Deck>>> = {};
  for (const layer of DATA_LAYERS) {
    records[layer] = loadLayerDeckStore(layer).卡组;
  }
  return records;
}

/** 合并三层后的卡组: id → { 卡组, 来自哪一层 } */
export function loadDeckLayers(): Map<string, Layered<Deck>> {
  return mergeLayers(loadDeckLayerRecords());
}

/** 读取全部卡组 (三层合并, 按创建时间/插入顺序) */
export function loadDecks(): Deck[] {
  return [...loadDeckLayers().values()].map(hit => hit.value);
}

/** 读取指定阵营的卡组 */
export function loadDecksByFaction(faction: DeckFaction): Deck[] {
  return loadDecks().filter(deck => deck.阵营 === faction);
}

/** 依据 id 读取卡组 */
export function loadDeck(deck_id: string): Deck | undefined {
  return loadDeckLayers().get(deck_id)?.value;
}

/** 这个卡组「住」在哪一层; 不存在时返回 null */
export function deckLayer(deck_id: string): DataLayer | null {
  return loadDeckLayers().get(deck_id)?.layer ?? null;
}

/** 往某一层里写回单个卡组 (内部用) */
function writeDeckToLayer(deck: Deck, layer: DataLayer): void {
  const store = loadLayerDeckStore(layer);
  store.卡组[deck.id] = deck;
  saveLayerDeckStore(layer, store);
}

/** 从某一层里移除卡组 (不动其他层) */
function deleteDeckFromLayer(deck_id: string, layer: DataLayer): boolean {
  const store = loadLayerDeckStore(layer);
  if (!_.has(store.卡组, deck_id)) {
    return false;
  }
  delete store.卡组[deck_id];
  if (store.出战卡组 === deck_id) {
    store.出战卡组 = '';
  }
  saveLayerDeckStore(layer, store);
  return true;
}

/**
 * 新增或覆盖一个卡组.
 *
 * `layer` 省略时写回这个卡组原本所在的层 (不会把一张全局卡组偷偷搬进当前聊天);
 * 是一个新卡组时才落到位置偏好里选的层.
 */
export function saveDeck(deck: DeckInput, layer?: DataLayer): Deck {
  const parsed = DeckSchema.parse(deck);
  writeDeckToLayer(parsed, layer ?? deckLayer(parsed.id) ?? preferredLayer());
  return parsed;
}

/** 新建一个空卡组并写入, 返回新卡组 */
export function createDeck(名称 = '', 阵营: DeckFaction = '我方', layer?: DataLayer): Deck {
  const deck = DeckSchema.parse({
    id: uuidv4(),
    名称,
    阵营,
    卡牌: [],
    备注: '',
    创建时间: Date.now(),
  });
  return saveDeck(deck, layer ?? preferredLayer());
}

/** 删除卡组 (从它所在的那一层删); 若它是当前出战卡组则同时清空出战记录 */
export function deleteDeck(deck_id: string): boolean {
  const layer = deckLayer(deck_id);
  if (!layer) {
    return false;
  }
  const removed = deleteDeckFromLayer(deck_id, layer);
  // 其他地方把这个卡组设为默认的也要一并抹掉, 否则会留个指不到人的指针
  clearDeployedDeckIdFor(deck_id);
  if (loadDeployedDeck()?.卡组id === deck_id) {
    clearDeployedDeck();
  }
  return removed;
}

// ---- 出战卡组 (三层回退) ----

/**
 * 出战卡组指针.
 *
 * 每一层都能存一个「默认出战卡组」, 取的时候按 聊天 > 角色卡 > 全局 回退 ——
 * 当前对话自己选过的优先, 没选过就用角色卡带的默认, 再没有就用全局默认.
 */
export function loadDeployedDeckPointer(): { deck_id: string; layer: DataLayer } | null {
  // 卡组已经被删掉的指针直接忽略, 继续往下找 (免得卡在一个不存在的卡组上)
  const decks = loadDeckLayers();
  for (const layer of DATA_LAYERS) {
    const deck_id = loadLayerDeckStore(layer).出战卡组;
    if (deck_id && decks.has(deck_id)) {
      return { deck_id, layer };
    }
  }
  return null;
}

/** 当前出战卡组的 id (三层回退的结果; 没选出战卡组时是空串) */
export function loadDeployedDeckId(): string {
  return loadDeployedDeckPointer()?.deck_id ?? '';
}

/** 某一层自己存的出战卡组 id (不往别层回退; 空串表示这一层没选过) */
export function loadLayerDeployedDeckId(layer: DataLayer): string {
  return loadLayerDeckStore(layer).出战卡组;
}

/** 把出战指针写到某一层 (小范围的那层会盖住大范围的) */
export function setDeployedDeckId(deck_id: string, layer: DataLayer): void {
  const store = loadLayerDeckStore(layer);
  store.出战卡组 = deck_id;
  saveLayerDeckStore(layer, store);
}

/** 清掉出战指针 (省略 `layer` 时清掉所有层的) */
export function clearDeployedDeckId(layer?: DataLayer): void {
  for (const target of layer ? [layer] : DATA_LAYERS) {
    const store = loadLayerDeckStore(target);
    if (store.出战卡组) {
      store.出战卡组 = '';
      saveLayerDeckStore(target, store);
    }
  }
}

/** 清掉所有指间某个卡组的出战指针 (删卡组时用) */
function clearDeployedDeckIdFor(deck_id: string): void {
  for (const layer of DATA_LAYERS) {
    const store = loadLayerDeckStore(layer);
    if (store.出战卡组 === deck_id) {
      store.出战卡组 = '';
      saveLayerDeckStore(layer, store);
    }
  }
}

/** 能在哪些位置放卡组 (供面板的位置选择器列出) */
export function deckLayers(): DataLayer[] {
  return availableLayers();
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

/** 卡组里的毛病统计 (按卡组里的张数算: 同一张卡带 3 份就算 3 张) */
export interface DeckIssues {
  /** 卡牌还在, 但数据没填完 / 数值读不懂 (照常上场, 少用的只是机读效果与读不出的数值) */
  不完整: number;
  /** 卡牌已不在卡牌库 (出战 / 战斗时会被跳过) */
  缺失: number;
}

/**
 * 统计一个卡组里有多少张卡「数据不完整 / 已不在卡牌库」.
 *
 * 判定与卡牌库面板的逐张提醒完全一致 (共用 `cardIssues`), 卡组面板的汇总、卡组列表的小标记
 * 与开战页的「（不完整）」后缀都用这一份, 免得三处判得不一样.
 * `cards` 可传入已经读好的卡牌库 (面板里已经读过一次时别再读一遍变量).
 */
export function deckIssues(deck: Deck, cards?: Card[]): DeckIssues {
  const by_id = new Map((cards ?? loadCards()).map(card => [card.id, card]));
  let 不完整 = 0;
  let 缺失 = 0;
  for (const card_id of deck.卡牌) {
    const card = by_id.get(card_id);
    if (!card) {
      缺失 += 1;
    } else if (cardIssues(card).length > 0) {
      不完整 += 1;
    }
  }
  return { 不完整, 缺失 };
}

/** 这个卡组是否「能用但不完整」(有卡数据不完整, 或有卡已不在卡牌库) */
export function isDeckIncomplete(deck: Deck, cards?: Card[]): boolean {
  const { 不完整, 缺失 } = deckIssues(deck, cards);
  return 不完整 + 缺失 > 0;
}

/** 毛病的一句话说明 (「2 张卡数据不完整, 1 张已不在卡牌库」); 没问题时是空串 */
export function describeDeckIssues(issues: DeckIssues): string {
  const parts: string[] = [];
  if (issues.不完整) {
    parts.push(`${issues.不完整} 张卡数据不完整`);
  }
  if (issues.缺失) {
    parts.push(`${issues.缺失} 张已不在卡牌库`);
  }
  return parts.join(', ');
}

/**
 * 让某个卡组出战: 把完整卡牌快照写入聊天变量 `战斗.出战卡组`,
 * 并把出战指针记在**当前对话**这一层 (每个对话可以各选各的, 不影响其他对话).
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
  setDeployedDeckId(deck.id, '聊天');
  return { deployed, 缺失 };
}

/**
 * 把某个卡组设为某一层的默认出战卡组 (在面板上明确选了「设为 xx 默认」时才调).
 *
 * 范围更小的层会盖住它 —— 当前对话自己选过的卡组依旧优先.
 */
export function setDefaultDeployedDeck(deck_id: string, layer: DataLayer): void {
  setDeployedDeckId(deck_id, layer);
}

/** 读取当前出战卡组快照 (未出战时返回 undefined) */
export function loadDeployedDeck(): DeployedDeck | undefined {
  if (!hasChat()) {
    return undefined;
  }
  try {
    const raw = _.get(getVariables({ type: 'chat' }), `${BATTLE_CHAT_KEY}.${DEPLOYED_DECK_KEY}`);
    if (raw !== undefined && raw !== null) {
      return DeployedDeckSchema.parse(raw);
    }
  } catch {
    /* 快照读不出来就退回默认 */
  }
  // 这个对话没手动选过: 用默认 (角色卡默认 > 全局默认) 当场现组一份快照, 不往变量里写
  const pointer = loadDeployedDeckPointer();
  if (!pointer) {
    return undefined;
  }
  const deck = loadDeck(pointer.deck_id);
  if (!deck) {
    return undefined;
  }
  try {
    return DeployedDeckSchema.parse({
      卡组id: deck.id,
      名称: deck.名称,
      备注: deck.备注,
      卡牌: resolveDeck(deck).卡牌,
      选择时间: new Date().toISOString(),
    });
  } catch {
    return undefined;
  }
}

/** 取消出战 (删掉当前对话的出战快照与出战选择; 别处的默认不受影响) */
export function clearDeployedDeck(): void {
  updateVariablesWith(
    variables => {
      _.unset(variables, `${BATTLE_CHAT_KEY}.${DEPLOYED_DECK_KEY}`);
      return variables;
    },
    { type: 'chat' },
  );
  clearDeployedDeckId('聊天');
}

// ---- 导出 / 导入 ----

/**
 * 取某些卡组 (不传就取全部) 的完整信息; 传空数组表示一套都不要.
 * 顺序按卡组列表的顺序 (创建时间), 导出文件读起来才顺.
 */
export function exportDecks(deck_ids?: readonly string[]): Deck[] {
  const decks = loadDecks();
  if (deck_ids === undefined) {
    return decks;
  }
  const wanted = new Set(deck_ids);
  return decks.filter(deck => wanted.has(deck.id));
}

/** 批量写入的统计 */
export interface WriteDecksResult {
  /** 新增的卡组数 */
  新增: number;
  /** 覆盖 (同 id 已存在) 的卡组数 */
  覆盖: number;
}

/**
 * 把一批卡组写入某一层 (同 id 覆盖, 其余新增).
 *
 * 这里不碰「出战卡组」指针 —— 那是每个对话 / 每张角色卡自己的选择,
 * 导入一份卡组不应该把别人正在用的出战卡组顶掉.
 */
export function writeDecks(decks: readonly Deck[], layer: DataLayer): WriteDecksResult {
  const store = loadLayerDeckStore(layer);
  let 新增 = 0;
  let 覆盖 = 0;
  for (const deck of decks) {
    if (_.has(store.卡组, deck.id)) {
      覆盖 += 1;
    } else {
      新增 += 1;
    }
    store.卡组[deck.id] = deck;
  }
  saveLayerDeckStore(layer, store);
  return { 新增, 覆盖 };
}

/** 清空某一层的卡组 (连这一层的出战卡组选择一起清; 只删本脚本自己的命名空间) */
export function clearDeckLayer(layer: DataLayer): void {
  deleteLayerKey(layer, DECK_CHAT_KEY);
}

// ---- 迁移 ----

/**
 * 从 `layer` 这一层看过去, 这张卡能不能用.
 *
 * 一张卡住的地方范围不小於查看的层, 就看得见 (全局卡在哪儿都能用).
 */
function cardVisibleFrom(card_id: string, layer: DataLayer): boolean {
  const home = cardLayer(card_id);
  return home !== null && layerRank(home) >= layerRank(layer);
}

/**
 * 这些卡组里, 换个位置之后会用不上的卡牌 id.
 *
 * 用于迁移前告诉用户「一并迁移用到的 N 张卡 / 只迁移卡组」.
 */
export function missingCardsForDecks(deck_ids: string[], to: DataLayer): string[] {
  const missing = new Set<string>();
  for (const deck_id of deck_ids) {
    const deck = loadDeck(deck_id);
    if (!deck) {
      continue;
    }
    for (const card_id of deck.卡牌) {
      if (!cardVisibleFrom(card_id, to)) {
        missing.add(card_id);
      }
    }
  }
  return [...missing];
}

/**
 * 把卡组写入指定位置 (供迁移用).
 *
 * - `复制`: 在目标层生成一套独立副本 (新卡组 id); `一并迁移卡牌` 为真时,
 *   副本引用的卡牌也会 Copy 一份到目标层, 副本改指向新的卡牌 id;
 * - `移动`: 先写进目标层, 再从原层移除 (同一套卡组只会在一个地方).
 *
 * 已经在目标层的不动. 返回写回去的卡组、新建的卡牌张数与跳过数.
 */
export function migrateDecks(
  deck_ids: string[],
  to: DataLayer,
  mode: 'move' | 'copy',
  options: { 一并迁移卡牌?: boolean } = {},
): { 写入: Deck[]; 卡牌: number; 跳过: number } {
  const card_id_map: Record<string, string> = {};
  let card_count = 0;
  if (options.一并迁移卡牌 && mode === 'copy') {
    const missing = missingCardsForDecks(deck_ids, to);
    if (missing.length) {
      const result = migrateCards(missing, to, 'copy');
      Object.assign(card_id_map, result.新id);
      card_count = result.写入.length;
    }
  } else if (options.一并迁移卡牌) {
    const missing = missingCardsForDecks(deck_ids, to);
    if (missing.length) {
      const result = migrateCards(missing, to, 'move');
      card_count = result.写入.length;
    }
  }

  const 写入: Deck[] = [];
  let 跳过 = 0;
  for (const deck_id of deck_ids) {
    const hit = loadDeckLayers().get(deck_id);
    if (!hit || hit.layer === to) {
      // 已经在目标层 / 已经没了: 不动
      跳过 += 1;
      continue;
    }
    const 卡牌 = hit.value.卡牌.map(id => card_id_map[id] ?? id);
    if (mode === 'move') {
      const moved = DeckSchema.parse({ ...hit.value, 卡牌 });
      writeDeckToLayer(moved, to);
      // 先在目标层落盘再删原层: 中途出错也只会多一份, 不会丢
      deleteDeckFromLayer(deck_id, hit.layer);
      写入.push(moved);
      continue;
    }
    const copy = DeckSchema.parse({ ...hit.value, id: uuidv4(), 卡牌 });
    writeDeckToLayer(copy, to);
    写入.push(copy);
  }
  return { 写入, 卡牌: card_count, 跳过 };
}

/** 卡牌库中是否已有卡牌 (没有卡牌时卡组没有内容可选) */
export function hasCards(): boolean {
  try {
    return loadCards().length > 0;
  } catch {
    return false;
  }
}
