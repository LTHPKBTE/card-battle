// 卡牌库数据访问层: 以 "角色卡变量 (character)" 为存储, 命名空间 `卡牌库`
import { literalYamlify, parseString, uuidv4 } from '@util/common';
import {
  CARD_EXPORT_FORMAT,
  CARD_LIBRARY_KEY,
  CARD_LIBRARY_VERSION,
  CardExportSchema,
  CardLibrarySchema,
  CardSchema,
  parseLegacyStars,
  type Card,
  type CardExport,
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

/** 读取卡牌库整体数据 (若角色卡变量中还不存在则返回空库, 并按版本迁移) */
export function loadLibrary(): CardLibrary {
  const variables = getVariables({ type: 'character' });
  return migrateLibrary(_.get(variables, CARD_LIBRARY_KEY));
}

/** 读取全部卡牌, 返回副本数组 (顺序按记录插入顺序, 与 UI 排序无关) */
export function loadCards(): Card[] {
  const library = loadLibrary();
  return _.values(library.卡牌);
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
  return loadLibrary().卡牌[card_id];
}

/** 写回单张卡牌 (新增或覆盖), 保存前按 schema 校验 */
export function saveCard(card: CardInput): void {
  const parsed = CardSchema.parse(card);
  // 机读区为空时彻底移除该键, 避免被存成 null
  if (parsed.machine_effect == null) {
    delete parsed.machine_effect;
  }
  updateVariablesWith(
    variables => {
      _.set(variables, `${CARD_LIBRARY_KEY}.版本`, CARD_LIBRARY_VERSION);
      if (!_.has(variables, `${CARD_LIBRARY_KEY}.卡牌`)) {
        _.set(variables, `${CARD_LIBRARY_KEY}.卡牌`, {});
      }
      _.set(variables, `${CARD_LIBRARY_KEY}.卡牌.${parsed.id}`, parsed);
      return variables;
    },
    { type: 'character' },
  );
}

/** 新建一张卡牌并立即写回, 返回写回后的完整卡牌 */
export function createCard(partial?: Partial<CardInput>): Card {
  const card = CardSchema.parse({
    id: uuidv4(),
    name: '',
    type: '从者',
    rarity: 'N',
    ...partial,
  });
  card.created_at = Date.now();
  saveCard(card);
  return card;
}

/** 删除一张卡牌, 返回是否实际删除 */
export function deleteCardById(card_id: string): boolean {
  const { delete_occurred } = deleteVariable(`${CARD_LIBRARY_KEY}.卡牌.${card_id}`, { type: 'character' });
  return delete_occurred;
}

// ---- 导出 / 导入 ----

/** 导出当前卡牌库为版本化 JSON 字符串 (供下载保存) */
export function exportLibraryToJson(): string {
  const export_data: CardExport = CardExportSchema.parse({
    格式: CARD_EXPORT_FORMAT,
    版本: CARD_LIBRARY_VERSION,
    导出时间: new Date().toISOString(),
    卡牌: loadCards(),
  });
  return JSON.stringify(export_data, null, 2);
}

/** 导入结果统计 */
export interface ImportResult {
  /** 新增的卡牌数 */
  imported: number;
  /** 被覆盖 (同名 id) 的卡牌数 */
  updated: number;
  /** 文件中的卡牌总数 */
  total: number;
}

/**
 * 解析并校验导出文本, 返回迁移到当前版本后的卡牌数组 (不写入).
 * 供导入前预览/确认数量使用.
 */
export function parseLibraryExport(text: string): Card[] {
  const raw = parseString(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('导入内容必须是 YAML/JSON 对象 (键值对), 不支持标量或数组');
  }
  if (raw['格式'] !== CARD_EXPORT_FORMAT) {
    throw new Error(`不是有效的卡牌库导出文件: 缺少「格式: ${CARD_EXPORT_FORMAT}」标记`);
  }

  const version = Number(raw['版本']) || 1;
  const raw_cards: unknown[] = Array.isArray(raw['卡牌']) ? raw['卡牌'] : _.values(raw['卡牌'] ?? {});

  // 先按版本迁移原始数据 (旧版 stars 是自由文本), 再逐张校验
  const raw_record = Object.fromEntries(raw_cards.map((item, index) => [String(index), item]));
  const migrated_library = migrateRaw({ 版本: version, 卡牌: raw_record });
  const migrated_cards = _.values(_.isPlainObject(migrated_library.卡牌) ? migrated_library.卡牌 : {});

  // 先全部校验通过, 再构建 record (任何一张不合法都直接抛错, 不写入)
  const keyed: Record<string, Card> = {};
  const errors: string[] = [];
  migrated_cards.forEach((item, index) => {
    try {
      const parsed = CardSchema.parse(item);
      keyed[parsed.id] = parsed;
    } catch (error) {
      const name = (item && typeof item === 'object' && 'name' in item && item.name) || `第 ${index + 1} 张`;
      errors.push(`「${String(name)}」: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (errors.length) {
    throw new Error(`导入失败, 以下卡牌格式不合法:\n${errors.join('\n')}`);
  }

  return _.values(keyed);
}

/**
 * 从导出的 JSON/YAML/JSON5 文本导入卡牌库.
 *
 * 流程: 解析文本 → 校验「格式」标记 → 按 id 转为 record → 迁移到当前版本 →
 * 逐张通过 schema 校验 → 与现有卡牌库按 id 合并 (覆盖同名 id, 保留其余).
 * 任何一张卡牌校验失败都不会写入 (整体回滚).
 */
export function importLibraryFromText(text: string): ImportResult {
  const cards = parseLibraryExport(text);
  const existing_ids = new Set(loadCards().map(card => card.id));
  let imported = 0;
  let updated = 0;
  for (const card of cards) {
    if (existing_ids.has(card.id)) {
      updated += 1;
    } else {
      imported += 1;
    }
    saveCard(card);
  }
  return { imported, updated, total: cards.length };
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
