// 卡牌库的数据结构定义 (zod 4)
// - `卡牌` 中的每张卡同时包含: 供玩家/界面阅读的自然语言字段 (`description`), 与供引擎/脚本识别的结构化效果 (`machine_effect`)
// - 变量结构注册到 "角色卡变量", 命名空间为 `卡牌库`

import { z } from 'zod';

/** 卡牌库在角色卡变量中的命名空间键 */
export const CARD_LIBRARY_KEY = '卡牌库';

/** 卡牌库存储格式的当前版本号 (升级格式时 +1, 并在 data.ts 的 migrations 中登记迁移函数) */
export const CARD_LIBRARY_VERSION = 4;

/** 卡牌库导出文件中的「格式」标记, 用于导入时校验文件类型 */
export const CARD_EXPORT_FORMAT = '卡牌库导出';

/** 卡牌稀有度选项 */
export const RARITIES = ['N', 'R', 'SR', 'SSR', 'UR'] as const;
export type Rarity = (typeof RARITIES)[number];

/**
 * 卡牌阵营.
 * - `通用`: 双方都能使用 (默认)
 * - `我方` / `敌方`: 只在对应阵营的卡组里出现, 用于把「玩家自己的卡」与「AI 的卡」分开存放,
 *   避免玩家在组卡时被剧透敌方卡牌
 */
export const CARD_FACTIONS = ['通用', '我方', '敌方'] as const;
export type CardFaction = (typeof CARD_FACTIONS)[number];

/** 卡牌类型选项 (仅供界面快捷选择, 不限制自由输入) */
export const CARD_TYPE_CHOICES = ['从者', '魔法', '咒术', '道具', '陷阱', '场地', '联动'] as const;

/** 星级上限: 界面提供 0 (未设置) 与 1-8 星选择 */
export const MAX_STARS = 8;

/**
 * 把 `stars` 的任意旧格式解析为 0-8 的星数.
 *
 * 旧版该字段是自由文本 ("★★★" / "★ x3" / "4"), 版本 2 起改为数值;
 * 迁移与 schema 兼容都复用它, 即使库数据已标记为新版本、个别卡仍是旧文本也能正常读取.
 */
export function parseLegacyStars(value: unknown): number {
  const clamp = (n: number) => Math.min(Math.max(Math.trunc(n), 0), MAX_STARS);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clamp(value);
  }
  const text = String(value ?? '').trim();
  if (!text) {
    return 0;
  }
  // "★ x3" / "★★★★ x2" 等带份数的写法: 优先取 x 后的数字
  const times = text.match(/[x×]\s*(\d+)/i);
  if (times) {
    return clamp(Number(times[1]));
  }
  // 纯星号写法: 数 ★ 的个数
  const star_count = (text.match(/★/g) ?? []).length;
  if (star_count > 0) {
    return clamp(star_count);
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? clamp(numeric) : 0;
}

/** 星级字段: 兼容旧文本, 输出 0-8 的整数 (0 表示未设置) */
const StarsSchema = z.preprocess(parseLegacyStars, z.number().int().min(0).max(MAX_STARS));

/**
 * 单张卡牌的机器可识别效果 (machine_effect)
 *
 * 只做"是一个对象"的宽松约束, 字段完全自由 (YAML 录入), 便于未来扩展识别执行;
 * 已知约定示例:
 * ```yaml
 * trigger: CONTINUOUS                    # 触发时机: CONTINUOUS / ON_PLAY / ON_ATTACK ...
 * condition:                             # 可选, 触发条件 (结构自由)
 *   exists: { owner: SELF, zone: GRAVEYARD, series: 炎龙 }
 * operation:                             # 可选, 具体操作 (结构自由)
 *   type: ADD_MODIFIER
 *   stat: attack
 *   layer: PERCENT_ADD
 *   value: 0.2
 * ```
 *
 * 允许缺省或为 null (旧版自动保存把清空误存为 null), 读取时统一按 undefined 处理.
 */
export const MachineEffectSchema = z.preprocess(value => value ?? undefined, z.looseObject({}).optional());

/** 单张卡牌 */
export const CardSchema = z.object({
  /** 唯一标识 (uuid), 由界面生成 */
  id: z.string(),

  /** 卡名 */
  name: z.string(),

  /** 所属系列, 如 "炎龙", 供机读条件判断同系列 */
  series: z.string().prefault(''),

  /** 阵营: 通用 / 我方 / 敌方 (旧数据缺失时视为「通用」) */
  阵营: z.enum(CARD_FACTIONS).prefault('通用'),

  /** 稀有度 */
  rarity: z.enum(RARITIES),

  /** 星级 (0 表示未设置, 1-8 由界面选择; 旧版自由文本如 "★ x3" 会在读取/迁移时自动转换) */
  stars: StarsSchema,

  /** 卡牌类型: 从者/魔法/陷阱... */
  type: z.string(),

  /** 属性 (水/火/光/量子...) */
  attribute: z.string().prefault(''),

  /** 性别 */
  gender: z.string().prefault(''),

  /** 种族 */
  race: z.string().prefault(''),

  /** 身高 */
  height: z.string().prefault(''),

  /** 攻击力, 允许 "300[+100]" 这类带计算说明的文本 */
  atk: z.string().prefault(''),

  /** 护盾值 (战斗中先扣护盾, 扣完才开始扣生命), 允许带计算说明文本 */
  shield: z.string().prefault(''),

  /** 生命值, 允许带计算说明文本 */
  hp: z.string().prefault(''),

  /**
   * 上场要消耗的能量, 允许带计算说明文本.
   *
   * 名字故意取得通用 (「能量」而不是「费用/法力」): 这个脚本要跨角色卡复用,
   * 每张角色卡的设定都不一样, 通用的词才不会跟世界观打架。
   * 留空视为 0 (旧卡不受影响).
   */
  energy: z.string().prefault(''),

  /** 自然语言效果/描述, 用于玩家可读的面板呈现 */
  description: z.string().prefault(''),

  /** 机读效果结构, 供引擎与脚本识别执行 (YAML 编辑, 可为空) */
  machine_effect: MachineEffectSchema,

  /** 创建时间戳, 用于保持插入顺序 (旧数据缺失时视为最早) */
  created_at: z.coerce.number().prefault(() => 0),
});
export type Card = z.output<typeof CardSchema>;
/** 可直接用于 z.infer 的输入类型 (卡字段全量写入时相同) */
export type CardInput = z.input<typeof CardSchema>;

/**
 * 卡牌库在角色卡变量中的整体结构.
 *
 * `版本` 使用数值 (而非字面量) 以便未来升级格式时, 旧数据仍能通过解析;
 * 升级流程: 将 CARD_LIBRARY_VERSION +1 → 在 data.ts 的 migrations 中登记
 * 「旧版本 -> 迁移到下一版本」的迁移函数 → 按需调整字段 schema.
 * 旧数据若缺失 `版本` 字段, 迁移层会按版本 1 处理.
 */
export const CardLibrarySchema = z
  .object({
    版本: z.coerce.number().prefault(CARD_LIBRARY_VERSION),
    卡牌: z.record(z.string(), CardSchema).prefault({}),
  })
  .prefault({ 版本: CARD_LIBRARY_VERSION, 卡牌: {} });
export type CardLibrary = z.output<typeof CardLibrarySchema>;

/** 注册到角色卡变量的结构 (变量管理器 UI 会据此校验/展示) */
export const CardLibraryVariableSchema = z.object({
  [CARD_LIBRARY_KEY]: CardLibrarySchema.prefault({ 版本: CARD_LIBRARY_VERSION, 卡牌: {} }),
});

/**
 * 卡牌库导出文件结构 (版本化, 与存储格式共用同一套迁移流程).
 * 卡牌以数组形式存放, 导入时按 id 转为存储用的 record 结构.
 */
export const CardExportSchema = z
  .object({
    格式: z.string().prefault(CARD_EXPORT_FORMAT),
    版本: z.coerce.number().prefault(CARD_LIBRARY_VERSION),
    导出时间: z.string().prefault(''),
    卡牌: z.array(CardSchema).prefault([]),
  })
  .prefault({ 格式: CARD_EXPORT_FORMAT, 版本: CARD_LIBRARY_VERSION, 导出时间: '', 卡牌: [] });
export type CardExport = z.output<typeof CardExportSchema>;
