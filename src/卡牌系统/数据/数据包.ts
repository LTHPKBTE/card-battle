// 数据包: 两种导出文件的格式与它们之间的纯逻辑 (可 node 测试)
//
// 两种文件:
//   分享导出 —— 只带卡牌与卡组, **不带位置**. 接受的人不一定有同一张角色卡, 带上位置
//               反而会让对方卡在一个用不了的层上; 导入时由导入方选放哪儿 (默认角色卡).
//   整包备份 —— 连「在哪一层」一起存, 恢复时努力还原到原来的层; 对方没有那张角色卡时
//               再由用户决定改道到全局还是跳过.
//
// 两种文件都只认识本脚本自己的命名空间 (卡牌库 / 卡组 / 战斗.出战卡组 / 脚本变量里的设置),
// 不会去碰别人写在同一层的别的键 —— 面板里也不摆多余的选项, 免得看起来像能操作别的数据.
//
// 这份文件不接触酒馆全局, 只做「解析 / 校验 / 汇总 / 改道」这类纯计算, 因此可以直接 node 跑.

import { z } from 'zod';

import { CardSchema, CARD_EXPORT_FORMAT, type Card } from '../卡牌/schema.ts';
import { DeckSchema, type Deck } from '../卡组/schema.ts';
import { PanelLookSchema, type PanelLook } from '../共用/外观.ts';
import { DATA_LAYERS, LayerSettingsSchema, type DataLayer, type LayerSettings } from '../共用/层级.ts';

/** 新版分享文件的「格式」标记 */
export const DATA_EXPORT_FORMAT = '卡牌战斗数据导出';
/** 整包备份的「格式」标记 */
export const DATA_BACKUP_FORMAT = '卡牌战斗数据备份';
/** 文件格式版本 (改结构时 +1) */
export const DATA_FILE_VERSION = 2;

/** 允许当分享文件导入的格式标记 (含旧版的单卡牌库导出文件) */
export const SHARE_FORMATS: readonly string[] = [DATA_EXPORT_FORMAT, CARD_EXPORT_FORMAT];

/** 一份备份里可以有哪些内容 */
export const DATA_PIECE_LABELS = ['卡牌', '卡组', '出战卡组'] as const;
export type DataPiece = (typeof DATA_PIECE_LABELS)[number];

/** 某一层里的一份数据 (备份的最小单位) */
export interface LayerSnapshot {
  卡牌?: Card[];
  卡组?: Deck[];
  /** 这一层记住的出战卡组 id */
  出战卡组?: string;
}

/** 备份里的各层数据 */
export type BackupLayers = Partial<Record<DataLayer, LayerSnapshot>>;

/** 分享文件 (卡牌 + 卡组, 没有位置) */
export interface ShareFile {
  格式: string;
  版本: number;
  导出时间: string;
  /** 从哪一层导出的 (仅供接收方参考, 导入时不使用) */
  来源: string;
  卡牌: Card[];
  卡组: Deck[];
}

/** 整包备份文件 */
export interface BackupFile {
  格式: string;
  版本: number;
  导出时间: string;
  层级: BackupLayers;
  /** 位置偏好 (存在脚本变量里, 与位置无关) */
  设置?: LayerSettings;
  /** 面板外观 */
  外观?: PanelLook;
}

const LayerSnapshotSchema = z.object({
  卡牌: z.array(CardSchema).optional(),
  卡组: z.array(DeckSchema).optional(),
  出战卡组: z.string().optional(),
});

/**
 * 各层数据. 三层写死成具名字段 (而不是 `z.record`) 是为了让「层级」里的键严格受控 ——
 * 文件里多出来的键一律被丢掉, 不会混进数据里.
 */
export const BackupLayersSchema = z.object({
  聊天: LayerSnapshotSchema.optional(),
  角色卡: LayerSnapshotSchema.optional(),
  全局: LayerSnapshotSchema.optional(),
});

const ShareFileSchema = z.object({
  格式: z.string().prefault(DATA_EXPORT_FORMAT),
  版本: z.coerce.number().prefault(DATA_FILE_VERSION),
  导出时间: z.string().prefault(''),
  来源: z.string().prefault(''),
  卡牌: z.array(CardSchema).prefault([]),
  卡组: z.array(DeckSchema).prefault([]),
});

const BackupFileSchema = z.object({
  格式: z.string().prefault(DATA_BACKUP_FORMAT),
  版本: z.coerce.number().prefault(DATA_FILE_VERSION),
  导出时间: z.string().prefault(''),
  层级: BackupLayersSchema.prefault({}),
  设置: LayerSettingsSchema.optional(),
  外观: PanelLookSchema.optional(),
});

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 把可能是「对象/数组」两种写法的列表归一成数组 (旧文件里存过对象) */
function asList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  return raw && typeof raw === 'object' ? Object.values(raw as Record<string, unknown>) : [];
}

/** 解析一份分享文件 (格式不对会抛错) */
export function parseShareFile(raw: unknown): ShareFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('导入内容必须是 YAML/JSON 对象 (键值对), 不支持标量或数组');
  }
  const record = raw as Record<string, unknown>;
  if (!SHARE_FORMATS.includes(String(record['格式'] ?? ''))) {
    throw new Error(`不是有效的卡牌 / 卡组分享文件: 缺少「格式: ${DATA_EXPORT_FORMAT}」标记`);
  }
  return ShareFileSchema.parse({
    ...record,
    卡牌: asList(record['卡牌']),
    卡组: asList(record['卡组']),
  });
}

/** 解析一份整包备份 (格式不对会抛错) */
export function parseBackupFile(raw: unknown): BackupFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('备份内容必须是 YAML/JSON 对象 (键值对), 不支持标量或数组');
  }
  if (String((raw as Record<string, unknown>)['格式'] ?? '') !== DATA_BACKUP_FORMAT) {
    throw new Error(`不是有效的备份文件: 缺少「格式: ${DATA_BACKUP_FORMAT}」标记`);
  }
  return BackupFileSchema.parse(raw) as BackupFile;
}

/** 丢掉空层 (某一层一份数据都没有时不留空壳, 免得备份里全是「0 张」) */
export function trimBackupLayers(layers: BackupLayers): BackupLayers {
  const out: BackupLayers = {};
  for (const layer of DATA_LAYERS) {
    const snapshot = layers[layer];
    if (!snapshot) {
      continue;
    }
    const trimmed: LayerSnapshot = {};
    if (snapshot.卡牌?.length) {
      trimmed.卡牌 = snapshot.卡牌;
    }
    if (snapshot.卡组?.length) {
      trimmed.卡组 = snapshot.卡组;
    }
    if (snapshot.出战卡组) {
      trimmed.出战卡组 = snapshot.出战卡组;
    }
    if (Object.keys(trimmed).length) {
      out[layer] = trimmed;
    }
  }
  return out;
}

/** 备份里各层的内容概述 (按范围从小到大排列) */
export interface LayerOutline {
  层级: DataLayer;
  卡牌: number;
  卡组: number;
}

export function backupOutline(layers: BackupLayers): LayerOutline[] {
  const rows: LayerOutline[] = [];
  for (const layer of DATA_LAYERS) {
    const snapshot = layers[layer];
    if (!snapshot) {
      continue;
    }
    const 卡牌 = snapshot.卡牌?.length ?? 0;
    const 卡组 = snapshot.卡组?.length ?? 0;
    if (卡牌 || 卡组) {
      rows.push({ 层级: layer, 卡牌, 卡组 });
    }
  }
  return rows;
}

/** 备份合计 (同名数据在不同层各算一次, 只用于显示) */
export function backupTotals(layers: BackupLayers): { 卡牌: number; 卡组: number } {
  let 卡牌 = 0;
  let 卡组 = 0;
  for (const row of backupOutline(layers)) {
    卡牌 += row.卡牌;
    卡组 += row.卡组;
  }
  return { 卡牌, 卡组 };
}

/** 一堆名字列成一句 (超过 2 个就折叠成「甲」「乙」等 N 项) */
export function nameList(names: readonly string[], 单位: string): string {
  const items = names.map(name => `「${name || '未命名'}」`);
  if (items.length <= 2) {
    return items.join('、') + 单位;
  }
  return `${items.slice(0, 2).join('、')}等 ${items.length} ${单位}`;
}

/** 一个分享文件里有什么 (一句说明) */
export function describeShare(file: ShareFile): string {
  return `${file.卡牌.length} 张卡牌, ${file.卡组.length} 套卡组`;
}

/** 一份备份里有什么 (一句说明) */
export function describeBackup(layers: BackupLayers): string {
  const rows = backupOutline(layers);
  if (!rows.length) {
    return '没有任何卡牌与卡组';
  }
  return rows.map(row => `${row.层级} ${row.卡牌} 张卡牌 / ${row.卡组} 套卡组`).join('; ');
}

// ---------------------------------------------------------------------------
// 恢复时的改道 (备份里的层在这台设备上用不了)
// ---------------------------------------------------------------------------

/** 缺失的一层, 以及它里面有什么 */
export interface MissingLayer {
  层级: DataLayer;
  卡组: Deck[];
  卡牌: Card[];
}

/** 一层实际装了哪些内容 (用于给缺失的那层起一段说明) */
export function describeLayer(snapshot: LayerSnapshot): string {
  const parts: string[] = [];
  if (snapshot.卡组?.length) {
    parts.push(nameList(snapshot.卡组.map(deck => deck.名称), '套卡组'));
  }
  if (snapshot.卡牌?.length) {
    parts.push(nameList(snapshot.卡牌.map(card => card.name), '张卡牌'));
  }
  return parts.join('; ');
}

/**
 * 备份里用了、但这台设备现在用不了的层.
 *
 * 「用不了」= 欢迎页没有角色卡、没进对话时没有聊天层等等. 这些层里的数据不能按原样写入,
 * 得先问用户改道到哪儿.
 */
export function missingLayers(layers: BackupLayers, 可用: readonly DataLayer[]): MissingLayer[] {
  const rows: MissingLayer[] = [];
  for (const layer of DATA_LAYERS) {
    const snapshot = layers[layer];
    if (!snapshot || 可用.includes(layer)) {
      continue;
    }
    if (!snapshot.卡牌?.length && !snapshot.卡组?.length) {
      continue;
    }
    rows.push({ 层级: layer, 卡组: snapshot.卡组 ?? [], 卡牌: snapshot.卡牌 ?? [] });
  }
  return rows;
}

/** 把若干层合并进一层时的去重 (同 id 只留第一次出现的) */
function pushUnique<T extends { id: string }>(target: T[], items: readonly T[], seen: Set<string>): void {
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    target.push(item);
  }
}

/** 改道结果 */
export interface RerouteResult {
  层级: BackupLayers;
  /** 真的被改了去向的层 */
  改道: { 从: DataLayer; 到: DataLayer }[];
}

/**
 * 按 `映射` 把若干层的数据并到新的层上 (缺失的层用这个改道到全局或当前角色卡).
 *
 * 合并时按 id 去重, 「出战卡组」保留先遇到的那个 (聊天 > 角色卡 > 全局, 与读出战的顺序一致).
 */
export function rerouteBackup(layers: BackupLayers, 映射: Partial<Record<DataLayer, DataLayer>>): RerouteResult {
  const out: BackupLayers = {};
  const 改道: { 从: DataLayer; 到: DataLayer }[] = [];
  for (const layer of DATA_LAYERS) {
    const snapshot = layers[layer];
    if (!snapshot) {
      continue;
    }
    const target = 映射[layer] ?? layer;
    if (target !== layer) {
      改道.push({ 从: layer, 到: target });
    }
    const merged = (out[target] ??= {});
    if (snapshot.卡牌?.length) {
      const 卡牌 = (merged.卡牌 ??= []);
      pushUnique(卡牌, snapshot.卡牌, new Set(卡牌.map(card => card.id)));
    }
    if (snapshot.卡组?.length) {
      const 卡组 = (merged.卡组 ??= []);
      pushUnique(卡组, snapshot.卡组, new Set(卡组.map(deck => deck.id)));
    }
    if (snapshot.出战卡组 && !merged.出战卡组) {
      merged.出战卡组 = snapshot.出战卡组;
    }
  }
  return { 层级: trimBackupLayers(out), 改道 };
}
