// 导出 / 导入 / 备份 / 恢复的流程 (弹窗 + 读写 + 下载)
//
// 三个面板共用这一份实现, 所以「卡牌库」的导出按钮、「卡组」的导出按钮、「数据」面板里的
// 备份与恢复, 行为完全一致: 同一套弹窗、同一套写入规则、同一套失败提示.
//
// 三条规矩:
//   1. 只写本脚本自己的命名空间 (卡牌库 / 卡组 / 战斗.出战卡组 / 脚本变量里的设置),
//      同一层里别人写的数据一律不碰 —— 所以这里没有任何「清空整个作用域」的操作;
//   2. 落盘之前先关掉所有面板: 面板卸载时会把编辑中的草稿写回变量, 顺序反了会把刚导入的盖掉;
//   3. 分享导出**不带位置** (接收方未必有同一张角色卡), 备份**带位置** (恢复时尽量还原原样).

import { askDialog, openDialog } from '../共用/弹窗';
import { parseString, viewportDocument, viewportWindow } from '../共用/平台';
import {
  DATA_LAYERS,
  LAYER_HINTS,
  availableLayers,
  flushLayerSettings,
  layerAvailable,
  loadLayerSettings,
  saveLayerSettings,
  type DataLayer,
} from '../共用/层级';
import { flushPanelLookSave, loadPanelLook, savePanelLook } from '../共用/外观';
import { closePanelsBut } from '../共用/面板';
import { cardLayer, clearCardLayer, exportCards, loadLayerLibrary, writeCards } from '../卡牌/data';
import {
  clearDeckLayer,
  deckLayer,
  exportDecks,
  loadDeck,
  loadLayerDeckStore,
  loadLayerDeployedDeckId,
  setDeployedDeckId,
  writeDecks,
} from '../卡组/data';
import { formatSize } from '../共用/体积';
import {
  DATA_BACKUP_FORMAT,
  DATA_EXPORT_FORMAT,
  DATA_FILE_VERSION,
  backupTotals,
  describeBackup,
  describeLayer,
  describeShare,
  missingLayers,
  parseBackupFile,
  parseShareFile,
  rerouteBackup,
  trimBackupLayers,
  type BackupFile,
  type BackupLayers,
  type LayerSnapshot,
  type MissingLayer,
  type ShareFile,
} from './数据包';

/** 导出文件大到这个程度就先提醒一下 (发进聊天很容易被平台截断) */
const BIG_FILE_BYTES = 256 * 1024;

/** 从备份恢复的等待确认时间 (毫秒) */
export const RESTORE_WAIT_MS = 3000;

// ---------------------------------------------------------------------------
// 与浏览器打交道的两个小工具 (面板都要用, 所以放在这里共用)
// ---------------------------------------------------------------------------

/** 下载一段文本 (挂在酒馆主文档上, 否则会被 0x0 的 iframe 裁掉) */
export function downloadText(filename: string, text: string): void {
  const doc = viewportDocument();
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  viewportWindow().setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 文件名里的时间戳 */
export function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 文本的字节数 (用于「文件会不会太大」的提示) */
function textBytes(text: string): number {
  return new Blob([text]).size;
}

/**
 * 让用户挑一个文件并读成文本; 取消选择时返回 null.
 *
 * 自己造一个 `input[type=file]` 而不是在模板里放一个, 是为了让三个面板共用同一份代码;
 * 取消选择不触发 `change`, 所以还要盯一下窗口重新获得焦点, 否则 Promise 会永远悬着.
 */
export function pickTextFile(accept = '.json,.yaml,.yml,.txt,application/json'): Promise<{ 名字: string; 文本: string } | null> {
  return new Promise(resolve => {
    const doc = viewportDocument();
    const win = viewportWindow();
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';

    let settled = false;
    const finish = (value: { 名字: string; 文本: string } | null) => {
      if (settled) {
        return;
      }
      settled = true;
      win.removeEventListener('focus', onFocus);
      input.remove();
      resolve(value);
    };
    const onFocus = () => {
      win.setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          finish(null);
        }
      }, 300);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      file
        .text()
        .then(text => finish({ 名字: file.name, 文本: text }))
        .catch(() => finish(null));
    });
    win.addEventListener('focus', onFocus);

    doc.body.appendChild(input);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// 取数据
// ---------------------------------------------------------------------------

/** 某一层里的卡牌与卡组 (导出与备份都从这里取原样数据) */
export function exportLayerSnapshot(layer: DataLayer): LayerSnapshot {
  const snapshot: LayerSnapshot = {
    卡牌: Object.values(loadLayerLibrary(layer).卡牌),
    卡组: Object.values(loadLayerDeckStore(layer).卡组),
  };
  const 出战卡组 = loadLayerDeployedDeckId(layer);
  if (出战卡组) {
    snapshot.出战卡组 = 出战卡组;
  }
  return snapshot;
}

/** 现在能读到的各层数据 (备份用; 空层会被丢掉) */
export function collectBackupLayers(): BackupLayers {
  const layers: BackupLayers = {};
  for (const layer of availableLayers()) {
    layers[layer] = exportLayerSnapshot(layer);
  }
  return trimBackupLayers(layers);
}

/** 这些数据分别住在哪些位置 (给分享文件填一个「来源」, 纯参考) */
function sourceLabel(layers: (DataLayer | null)[]): string {
  const unique = [...new Set(layers.filter((layer): layer is DataLayer => layer !== null))];
  if (!unique.length) {
    return '';
  }
  return unique.length === 1 ? unique[0] : '多个位置';
}

/** 卡组用到的卡牌 (按卡牌库顺序, 与选中的卡牌合并去重) */
function collectDeckCards(decks: readonly { 卡牌: string[] }[], extra_ids: readonly string[] = []): string[] {
  const wanted = new Set<string>();
  for (const deck of decks) {
    for (const card_id of deck.卡牌) {
      wanted.add(card_id);
    }
  }
  for (const card_id of extra_ids) {
    wanted.add(card_id);
  }
  return [...wanted];
}

// ---------------------------------------------------------------------------
// 分享导出 (卡牌 / 卡组, 不带位置)
// ---------------------------------------------------------------------------

export interface ShareExportOptions {
  /** 提示信息的标题 (哪个面板点出来的) */
  标题: string;
  /** 要导出的卡牌 id; 不传表示全部 */
  卡牌?: readonly string[];
  /** 要导出的卡组 id; 不传表示全部 */
  卡组?: readonly string[];
  /** 卡组默认是否带上用到的卡牌 */
  默认带卡?: boolean;
  /** 用哪个前缀命名文件 */
  文件前缀?: string;
}

/**
 * 分享导出.
 *
 * 只带卡牌与卡组本体, 不带它们原本住在哪一层: 拿到文件的人未必有同一张角色卡,
 * 带上位置只会让对方卡在一个用不了的层上 —— 位置由导入方自己选.
 */
export async function runShareExport(options: ShareExportOptions): Promise<boolean> {
  const 标题 = options.标题;
  const 卡组 = exportDecks(options.卡组);
  const 选中的卡牌 = exportCards(options.卡牌);
  const 卡组卡牌 = collectDeckCards(卡组, 选中的卡牌.map(card => card.id));
  /** 只有勾上「一并带上」才会写进文件的卡牌 */
  const 卡组相关卡牌 = collectDeckCards(卡组);
  const 额外卡牌 = 卡组相关卡牌.filter(id => !选中的卡牌.some(card => card.id === id));

  if (!选中的卡牌.length && !卡组.length) {
    toastr.warning('没有可导出的内容', 标题);
    return false;
  }

  // 只导出卡组时可以选「要不要把用到的卡牌一并带上」—— 不带的话对方会看到一堆「不完整」
  const 勾选 = 卡组.length
    ? {
        标签: '一并带上卡组用到的卡牌',
        说明: 额外卡牌.length
          ? `还有 ${额外卡牌.length} 张卡只在卡组里被引用, 对方没有这些卡时卡组会显示「不完整」`
          : '卡组引用到的卡牌都已经在本次导出里了',
        默认: options.默认带卡 !== false,
      }
    : undefined;

  const 内容 = [
    选中的卡牌.length ? `卡牌 ${选中的卡牌.length} 张` : '',
    卡组.length ? `卡组 ${卡组.length} 套` : '',
  ]
    .filter(Boolean)
    .join('、');

  const result = await askDialog({
    标题: '导出',
    内容: `${内容}。\n导出文件不带位置信息, 拿到它的人可以自己选放到哪里。`,
    勾选,
    确认文案: '导出',
  });
  if (result.button !== 'confirm') {
    return false;
  }

  const 卡牌 = result.勾选 ? exportCards(卡组卡牌) : 选中的卡牌;
  const 来源 = sourceLabel([
    ...卡牌.map(card => cardLayer(card.id)),
    ...卡组.map(deck => deckLayer(deck.id)),
  ]);
  const 文本 = JSON.stringify(
    {
      格式: DATA_EXPORT_FORMAT,
      版本: DATA_FILE_VERSION,
      导出时间: new Date().toISOString(),
      来源,
      卡牌,
      卡组,
    },
    null,
    2,
  );

  // 卡牌带在文本里发出去, 太大了先劝一句
  if (textBytes(文本) > BIG_FILE_BYTES && !(await confirmBigFile(文本, '导出'))) {
    return false;
  }

  downloadText(`${options.文件前缀 ?? '卡牌卡组'}-${fileStamp()}.json`, 文本);
  toastr.success(
    卡牌.length || 卡组.length
      ? `已导出 ${卡牌.length ? `${卡牌.length} 张卡牌` : ''}${卡牌.length && 卡组.length ? '、' : ''}${
          卡组.length ? `${卡组.length} 套卡组` : ''
        }`
      : '已导出',
    标题,
  );
  return true;
}

/** 文件太大时的二次确认 */
async function confirmBigFile(文本: string, 标题: string): Promise<boolean> {
  const result = await askDialog({
    标题: `${标题}的文件比较大`,
    内容: [
      `这个文件大约 ${formatSize(textBytes(文本))}。`,
      '直接发进聊天可能会很卡, 也可能被平台截断。',
      '建议少选一些内容分几次发, 自己留档则可以用「数据」面板里的备份。',
      '',
      '仍然继续吗?',
    ].join('\n'),
    确认文案: '继续',
    危险: true,
  });
  return result.button === 'confirm';
}

// ---------------------------------------------------------------------------
// 分享导入
// ---------------------------------------------------------------------------

/** 位置下拉框的选项 (范围从小到大) */
function layerOptions(可选: readonly DataLayer[]) {
  return 可选.map(layer => ({ value: layer, label: layer, 说明: LAYER_HINTS[layer] }));
}

/** 导入时默认放哪: 有角色卡就放角色卡, 没有就放全局 */
function defaultImportLayer(可选: readonly DataLayer[]): DataLayer {
  if (可选.includes('角色卡')) {
    return '角色卡';
  }
  return 可选.includes('全局') ? '全局' : (可选[0] ?? '全局');
}

/**
 * 分享导入: 挑文件 → 选放到哪一层 + 合并还是清空后写入 → 写入.
 *
 * 文件里没有别人的数据, 所以这里只写卡牌与卡组 —— 不碰同一层里别的键.
 */
export async function runShareImport(标题 = '导入'): Promise<boolean> {
  const picked = await pickTextFile();
  if (!picked) {
    return false;
  }

  let file: ShareFile;
  try {
    file = parseShareFile(parseString(picked.文本));
  } catch (error) {
    toastr.error(`「${picked.名字}」读取失败: ${error instanceof Error ? error.message : String(error)}`, 标题);
    return false;
  }

  const 可选 = availableLayers();
  if (!可选.length) {
    toastr.warning('请先进入一张角色卡或一个对话', 标题);
    return false;
  }
  if (!file.卡牌.length && !file.卡组.length) {
    toastr.warning('这个文件里没有卡牌与卡组', 标题);
    return false;
  }

  const 默认方向 = defaultImportLayer(可选);
  const 内容 = [`「${picked.名字}」`, describeShare(file)];
  if (!file.卡牌.length && file.卡组.length) {
    内容.push('文件里没有卡牌, 卡组用到的卡要你这边已经有才能正常出战。');
  }
  if (可选.length === 1) {
    内容.push(`放在: ${可选[0]}`);
  }

  const result = await askDialog({
    标题: '导入卡牌与卡组',
    内容: 内容.join('\n'),
    选择: 可选.length > 1 ? { 标签: '放在', 选项: layerOptions(可选), 默认: 默认方向 } : undefined,
    勾选: {
      标签: '先清空该位置再写入',
      说明: '不勾: 与现有数据合并 (同 id 覆盖, 其余保留)',
      默认: false,
    },
    确认文案: '导入',
  });
  if (result.button !== 'confirm') {
    return false;
  }

  const 方向 = (result.选择 || 默认方向) as DataLayer;
  // 先关面板再写: 面板卸载时会把编辑中的草稿落盘, 顺序反了会把刚导入的盖掉
  closePanelsBut();
  const written = applyShareImport(file, 方向, result.勾选);
  toastr.success(
    `已导入到${方向}: ${written.卡牌 ? `${written.卡牌} 张卡牌` : ''}${
      written.卡牌 && written.卡组 ? '、' : ''
    }${written.卡组 ? `${written.卡组} 套卡组` : ''}`,
    标题,
  );
  return true;
}

/** 真的把分享文件写进某一层 */
function applyShareImport(file: ShareFile, 方向: DataLayer, 清空: boolean): { 卡牌: number; 卡组: number } {
  if (清空) {
    clearCardLayer(方向);
    clearDeckLayer(方向);
  }
  const cards = file.卡牌.length ? writeCards(file.卡牌, 方向) : { 新增: 0, 覆盖: 0 };
  const decks = file.卡组.length ? writeDecks(file.卡组, 方向) : { 新增: 0, 覆盖: 0 };
  return { 卡牌: cards.新增 + cards.覆盖, 卡组: decks.新增 + decks.覆盖 };
}

// ---------------------------------------------------------------------------
// 整包备份 / 恢复
// ---------------------------------------------------------------------------

/** 备份: 把各层的卡牌与卡组连位置一起存下来 */
export async function runBackupExport(标题 = '备份'): Promise<boolean> {
  const layers = collectBackupLayers();
  const totals = backupTotals(layers);
  if (!totals.卡牌 && !totals.卡组) {
    toastr.warning('还没有可备份的卡牌与卡组', 标题);
    return false;
  }

  const result = await askDialog({
    标题: '备份数据',
    内容: [
      describeBackup(layers),
      '',
      '备份会记下每份数据原本放在聊天 / 角色卡 / 全局的哪一层, 换到别的设备或角色卡上时, 缺失的位置还能改道。',
      '位置偏好与面板外观也会一并存进去。',
    ].join('\n'),
    确认文案: '备份',
  });
  if (result.button !== 'confirm') {
    return false;
  }

  const 文本 = JSON.stringify(
    {
      格式: DATA_BACKUP_FORMAT,
      版本: DATA_FILE_VERSION,
      导出时间: new Date().toISOString(),
      层级: layers,
      设置: loadLayerSettings(),
      外观: loadPanelLook(),
    },
    null,
    2,
  );
  if (textBytes(文本) > BIG_FILE_BYTES) {
    toastr.warning(`备份大约 ${formatSize(textBytes(文本))}, 下载可能要等一下`, 标题);
  }
  downloadText(`卡牌系统备份-${fileStamp()}.json`, 文本);
  toastr.success(`已备份 ${totals.卡牌} 张卡牌、${totals.卡组} 套卡组`, 标题);
  return true;
}

/** 恢复: 挑文件 → (位置缺失时问怎么处理) → 选写入方式 → 落盘 */
export async function runBackupImport(标题 = '恢复'): Promise<boolean> {
  const picked = await pickTextFile();
  if (!picked) {
    return false;
  }

  let file: BackupFile;
  try {
    file = parseBackupFile(parseString(picked.文本));
  } catch (error) {
    toastr.error(`「${picked.名字}」读取失败: ${error instanceof Error ? error.message : String(error)}`, 标题);
    return false;
  }

  let layers = trimBackupLayers(file.层级);
  const 备份合计 = backupTotals(layers);
  if (!备份合计.卡牌 && !备份合计.卡组) {
    toastr.warning('这份备份里没有卡牌与卡组', 标题);
    return false;
  }

  // 备份里用到的位置, 现在可能不存在 (对方没有那张角色卡 / 还没进对话)
  const 可用 = availableLayers();
  const 缺失 = missingLayers(layers, 可用);
  if (缺失.length) {
    const 改道 = await askMissingLayers(缺失, 可用.includes('角色卡'));
    if (!改道) {
      return false;
    }
    if (改道.跳过) {
      const 保留: BackupLayers = { ...layers };
      for (const row of 缺失) {
        delete 保留[row.层级];
      }
      layers = 保留;
    } else {
      const 映射: Partial<Record<DataLayer, DataLayer>> = {};
      for (const row of 缺失) {
        映射[row.层级] = 改道.目标;
      }
      layers = rerouteBackup(layers, 映射).层级;
    }
  }

  const totals = backupTotals(layers);
  const 内容 = [
    `「${picked.名字}」`,
    `备份里: ${describeBackup(layers)}`,
    '',
    '即将把上面的内容写回来。',
    '位置偏好与面板外观会按备份恢复。',
  ];

  const result = await askDialog({
    标题: '从备份恢复',
    内容: 内容.join('\n'),
    勾选: {
      标签: '先清空这些位置再写入',
      说明: '勾上 = 还原成备份当时的样子 (该位置上现有的卡牌与卡组会被删除); 不勾 = 与现有数据合并',
      默认: true,
    },
    确认文案: '恢复',
    危险: true,
    等待毫秒: RESTORE_WAIT_MS,
  });
  if (result.button !== 'confirm') {
    return false;
  }

  closePanelsBut();
  const written = applyBackupLayers(layers, result.勾选);
  applyBackupSettings(file);
  toastr.success(
    `已恢复 ${written.卡牌} 张卡牌、${written.卡组} 套卡组${written.层级.length ? ` (${written.层级.join(' / ')})` : ''}`,
    标题,
  );
  return true;
}

/** 位置缺失时的选择 */
async function askMissingLayers(
  缺失: MissingLayer[],
  有角色卡: boolean,
): Promise<{ 跳过: boolean; 目标: DataLayer } | null> {
  const lines = [
    '这份备份把一些数据放在这台设备上没有的位置, 没法按原样放回去:',
    '',
    ...缺失.map(row => `· ${row.层级}: ${describeLayer({ 卡牌: row.卡牌, 卡组: row.卡组 })}`),
    '',
    '要怎么办?',
    '· 转到全局: 所有角色卡、所有对话都能用',
    ...(有角色卡 ? ['· 转到我当前的角色卡: 只有这张角色卡能用'] : []),
    '· 跳过这部分: 这些内容不恢复, 备份里其余的部分照常恢复',
  ];

  const result = await openDialog({
    标题: '备份里的位置不存在',
    内容: lines.join('\n'),
    取消值: 'cancel',
    按钮: [
      { value: 'skip', label: '跳过这部分' },
      ...(有角色卡 ? [{ value: 'character', label: '转到我当前的角色卡' }] : []),
      { value: 'global', label: '转到全局', primary: true },
    ],
  });
  if (result.button === 'global') {
    return { 跳过: false, 目标: '全局' };
  }
  if (result.button === 'character') {
    return { 跳过: false, 目标: '角色卡' };
  }
  if (result.button === 'skip') {
    return { 跳过: true, 目标: '全局' };
  }
  return null;
}

/** 把备份里的各层数据写回来 (只写本脚本自己的命名空间) */
function applyBackupLayers(layers: BackupLayers, 清空: boolean): { 卡牌: number; 卡组: number; 层级: DataLayer[] } {
  let 卡牌 = 0;
  let 卡组 = 0;
  const 写入层: DataLayer[] = [];
  for (const layer of DATA_LAYERS) {
    const snapshot = layers[layer];
    if (!snapshot || !layerAvailable(layer)) {
      continue;
    }
    if (清空) {
      clearCardLayer(layer);
      clearDeckLayer(layer);
    }
    if (snapshot.卡牌?.length) {
      const result = writeCards(snapshot.卡牌, layer);
      卡牌 += result.新增 + result.覆盖;
    }
    if (snapshot.卡组?.length) {
      const result = writeDecks(snapshot.卡组, layer);
      卡组 += result.新增 + result.覆盖;
    }
    if (snapshot.出战卡组 && loadDeck(snapshot.出战卡组)) {
      setDeployedDeckId(snapshot.出战卡组, layer);
    }
    if (snapshot.卡牌?.length || snapshot.卡组?.length) {
      写入层.push(layer);
    }
  }
  return { 卡牌, 卡组, 层级: 写入层 };
}

/** 备份里的设置与外观 (按备份恢复; 这两样是全局的, 与位置无关) */
function applyBackupSettings(file: BackupFile): void {
  if (file.设置) {
    saveLayerSettings(file.设置);
    flushLayerSettings();
  }
  if (file.外观) {
    savePanelLook(file.外观);
    flushPanelLookSave();
  }
}
