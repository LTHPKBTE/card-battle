// 数据包 (导出 / 备份两种文件的格式与纯逻辑) - 测试脚本
//
// 运行: node src/卡牌系统/数据/测试.ts
//
// 只测纯计算部分 (解析 / 汇总 / 改道), 不碰酒馆变量与 DOM ——
// 与浏览器打交道的部分在 流程.ts, 那层不在这里测.

import { DATA_LAYERS, type DataLayer } from '../共用/层级.ts';
import {
  DATA_BACKUP_FORMAT,
  DATA_EXPORT_FORMAT,
  DATA_FILE_VERSION,
  SHARE_FORMATS,
  backupOutline,
  backupTotals,
  describeBackup,
  describeLayer,
  describeShare,
  missingLayers,
  nameList,
  parseBackupFile,
  parseShareFile,
  rerouteBackup,
  trimBackupLayers,
  type BackupLayers,
} from './数据包.ts';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  \u2714 ${name}`);
    return;
  }
  failed += 1;
  console.log(`  \u2718 ${name}`, detail === undefined ? '' : JSON.stringify(detail));
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

/** 抛错的用例统一用这个包一层, 返回错误信息 (没抛则返回 null 并记一次失败) */
function grabError(name: string, run: () => unknown): string | null {
  try {
    run();
    check(name, false, '本应抛错但没有');
    return null;
  } catch (error) {
    check(name, true);
    return error instanceof Error ? error.message : String(error);
  }
}

/** 最小可用的卡牌 / 卡组 (其余字段由 schema 的 prefault 补齐) */
const card = (id: string, name = '卡') => ({ id, name, rarity: 'R', type: '从者' });
const deck = (id: string, 名称 = '组') => ({ id, 名称, 卡牌: [] as string[] });

// ---------------------------------------------------------------------------
section('分享文件 (只带卡牌与卡组, 不带位置)');

{
  const file = parseShareFile({
    格式: DATA_EXPORT_FORMAT,
    版本: DATA_FILE_VERSION,
    导出时间: '2024-01-01T00:00:00.000Z',
    来源: '角色卡',
    卡牌: [card('c1', '炎龙')],
    卡组: [deck('d1', '炎龙组')],
  });
  check('新版分享文件能解析', file.卡牌.length === 1 && file.卡组.length === 1);
  check('卡牌缺省字段被补齐', file.卡牌[0].阵营 === '通用' && file.卡牌[0].stars === 0);
  check('来源原样保留', file.来源 === '角色卡');
  check('一句话说明', describeShare(file) === '1 张卡牌, 1 套卡组');

  // 旧版单卡牌库导出文件 (只有卡牌) 也要能导进来
  const legacy = parseShareFile({ 格式: '卡牌库导出', 版本: 1, 卡牌: [card('c1')] });
  check('旧版卡牌库导出文件仍可导入', legacy.卡牌.length === 1 && legacy.卡组.length === 0);
  check('旧标记在允许列表里', SHARE_FORMATS.includes('卡牌库导出'));

  // 旧文件里卡牌存成对象 (而不是数组) 的写法
  const as_record = parseShareFile({
    格式: DATA_EXPORT_FORMAT,
    卡牌: { c1: card('c1'), c2: card('c2') },
    卡组: { d1: deck('d1') },
  });
  check('对象写法的卡牌被归一成数组', as_record.卡牌.length === 2);
  check('对象写法的卡组被归一成数组', as_record.卡组.length === 1);

  const bare = parseShareFile({ 格式: DATA_EXPORT_FORMAT });
  check('没有卡牌 / 卡组时是空数组', bare.卡牌.length === 0 && bare.卡组.length === 0);

  const stray = parseShareFile({ 格式: DATA_EXPORT_FORMAT, 卡牌: [], 卡组: [], 别的东西: 1 }) as Record<string, unknown>;
  check('文件里多出来的键被丢掉', !('别的东西' in stray));

  const wrong = grabError('格式不对会报错', () => parseShareFile({ 格式: '随便', 卡牌: [] }));
  check('报错时点出正确标记', Boolean(wrong?.includes(DATA_EXPORT_FORMAT)));
  grabError('标量内容会报错', () => parseShareFile('卡牌'));
  grabError('数组内容会报错', () => parseShareFile([1, 2, 3]));
}

// ---------------------------------------------------------------------------
section('整包备份 (连位置一起存)');

{
  const file = parseBackupFile({
    格式: DATA_BACKUP_FORMAT,
    层级: { 角色卡: { 卡牌: [card('c1')], 出战卡组: 'd1' }, 全局: { 卡组: [deck('d1')] } },
  });
  check('备份能解析', file.层级.角色卡?.卡牌?.length === 1);
  check('没写的层不存在', file.层级.聊天 === undefined);
  check('出战卡组保留', file.层级.角色卡?.出战卡组 === 'd1');
  check('设置 / 外观可以缺省', file.设置 === undefined && file.外观 === undefined);

  const with_settings = parseBackupFile({
    格式: DATA_BACKUP_FORMAT,
    层级: {},
    设置: { 新建位置: '全局' },
    外观: { 垫底色: '#101020' },
  });
  check('设置随备份保存', with_settings.设置?.新建位置 === '全局');
  check('外观随备份保存', with_settings.外观?.垫底色 === '#101020');

  const stray = parseBackupFile({
    格式: DATA_BACKUP_FORMAT,
    层级: { 角色卡: { 卡牌: [card('c1')], 额外字段: 'x' }, 平行宇宙: { 卡牌: [card('c9')] } },
  }) as { 层级: Record<string, unknown> };
  check('层名不受文件控制 (多出来的层被丢掉)', !('平行宇宙' in stray.层级));
  check('层里多出来的字段被丢掉', !('额外字段' in (stray.层级.角色卡 as Record<string, unknown>)));

  grabError('备份格式不对会报错', () => parseBackupFile({ 格式: DATA_EXPORT_FORMAT, 层级: {} }));
  grabError('备份内容不是对象会报错', () => parseBackupFile(42));
}

// ---------------------------------------------------------------------------
section('备份汇总 (空层 / 空字段都丢掉)');

{
  const trimmed = trimBackupLayers({ 角色卡: {}, 全局: { 卡牌: [card('c1')] } });
  check('空层被丢掉', trimmed.角色卡 === undefined && trimmed.全局?.卡牌?.length === 1);

  const only_deployed = trimBackupLayers({ 角色卡: { 出战卡组: 'd1' } });
  check('只记了出战卡组的层保留', only_deployed.角色卡?.出战卡组 === 'd1');
  check('空数组字段被去掉', only_deployed.角色卡?.卡牌 === undefined);

  const layers: BackupLayers = { 聊天: { 卡牌: [card('a')] }, 全局: { 卡组: [deck('b')], 卡牌: [card('c')] } };
  const outline = backupOutline(layers);
  check('列出的层按范围从小到大', outline.length === 2);
  check('层名与数据一致', outline[0].层级 === '聊天' && outline[1].层级 === '全局');
  check('每层的数量正确', outline[1].卡牌 === 1 && outline[1].卡组 === 1);
  check('空层不进列表', backupOutline({ 角色卡: {} }).length === 0);

  const totals = backupTotals(layers);
  check('合计卡牌数', totals.卡牌 === 2);
  check('合计卡组数', totals.卡组 === 1);

  const order = backupOutline({ 全局: { 卡牌: [card('a')] }, 聊天: { 卡牌: [card('b')] } }).map(row => row.层级);
  check('顺序固定为聊天 → 角色卡 → 全局', order.join(',') === DATA_LAYERS.filter(layer => layer !== '角色卡').join(','));

  check('说明文案按层罗列', describeBackup(layers).includes('聊天 1 张卡牌 / 0 套卡组'));
  check('没有内容时明说', describeBackup({}) === '没有任何卡牌与卡组');
}

// ---------------------------------------------------------------------------
section('名字列句');

{
  check('一个名字直接用', nameList(['炎龙'], '张卡牌') === '「炎龙」张卡牌');
  const two = nameList(['甲', '乙'], '套卡组');
  check('两个名字都列出', two.includes('「甲」') && two.includes('「乙」') && !two.includes('等'));
  const many = nameList(['甲', '乙', '丙'], '套卡组');
  check('三个名字折叠', many.includes('等 3 套卡组') && !many.includes('「丙」'));
  check('没名字时写未命名', nameList([''], '张卡牌').includes('「未命名」'));
  check('空列表只留单位', nameList([], '张卡牌') === '张卡牌');
}

// ---------------------------------------------------------------------------
section('一层里有什么 (说明文案)');

{
  check('先卡组后卡牌', describeLayer({ 卡组: [deck('d1', '甲')], 卡牌: [card('c1', '乙')] }) === '「甲」套卡组; 「乙」张卡牌');
  check('只有卡牌时只说卡牌', describeLayer({ 卡牌: [card('c1', '乙')] }) === '「乙」张卡牌');
  check('什么都没有时是空串', describeLayer({}) === '');
}

// ---------------------------------------------------------------------------
section('缺失的层与改道');

{
  const layers: BackupLayers = { 角色卡: { 卡牌: [card('c1')] }, 全局: { 卡组: [deck('d1')] } };
  const 可用: DataLayer[] = ['聊天', '全局'];
  const missing = missingLayers(layers, 可用);
  check('用不了的那层被列出', missing.length === 1 && missing[0].层级 === '角色卡');
  check('缺失层带着里面的内容', missing[0].卡牌.length === 1 && missing[0].卡组.length === 0);
  check('可用层不算缺失', missingLayers(layers, ['聊天', '角色卡', '全局']).length === 0);
  check('只有出战卡组的层不算缺失', missingLayers({ 角色卡: { 出战卡组: 'd1' } }, 可用).length === 0);

  // 改道: 角色卡 -> 全局, 同 id 去重, 出战卡组保留先遇到的那个
  const rerouted = rerouteBackup(
    { 角色卡: { 卡牌: [card('c1')], 卡组: [deck('d1')], 出战卡组: 'd1' }, 全局: { 卡组: [deck('d1', '重复')] } },
    { 角色卡: '全局' },
  );
  check('改道后只剩目标层', rerouted.层级.角色卡 === undefined && rerouted.层级.全局 !== undefined);
  check('同 id 的卡组只留一份', rerouted.层级.全局?.卡组?.length === 1);
  check('改道记录写明从哪到哪', rerouted.改道.length === 1 && rerouted.改道[0].从 === '角色卡' && rerouted.改道[0].到 === '全局');
  check('出战卡组跟着数据走', rerouted.层级.全局?.出战卡组 === 'd1');

  const no_map = rerouteBackup({ 全局: { 卡牌: [card('c1')] } }, {});
  check('没给映射就原样保留', no_map.层级.全局?.卡牌?.length === 1 && no_map.改道.length === 0);
  check('改道后空层会被丢掉', rerouteBackup({ 角色卡: {} }, { 角色卡: '全局' }).层级.全局 === undefined);
}

console.log(`\n通过 ${passed} 项, 失败 ${failed} 项`);
if (failed > 0) {
  process.exitCode = 1;
}
