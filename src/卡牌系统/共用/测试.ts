// 数字输入框规范化 - 测试脚本
//
// 运行: node src/卡牌系统/共用/测试.ts

import { formatSize, jsonBytes } from './体积.ts';
import { normalizeNumberInput, numberInputFallback, resolveNumberInput } from './数字.ts';
import {
  DEFAULT_PANEL_ALPHA,
  DEFAULT_PANEL_BLUR,
  DEFAULT_PANEL_TINT,
  MAX_PANEL_BLUR,
  PanelLookSchema,
  defaultPanelLook,
  describePanelLook,
  flushPanelLookSave,
  hexToRgbParts,
  loadPanelLook,
  normalizeHex,
  onPanelLookChanged,
  panelLookStyle,
  resetPanelLook,
  savePanelLook,
} from './外观.ts';

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

/** 条数输入框的常用配置 (1~200, 清空回退 30) */
const COUNT = { min: 1, max: 200, fallback: 30 };

// ---------------------------------------------------------------------------
section('1 编辑中间态 (空串 / 非法内容)');
{
  check('空串不合法', normalizeNumberInput('') === null);
  check('纯空格不合法', normalizeNumberInput('   ') === null);
  check('非数字不合法', normalizeNumberInput('abc') === null);
  check('NaN 不合法', normalizeNumberInput('NaN') === null);
  check('Infinity 不合法', normalizeNumberInput('Infinity') === null);
  check('空串回退到 fallback', resolveNumberInput('', COUNT) === 30, resolveNumberInput('', COUNT));
  check('非法内容回退到 fallback', resolveNumberInput('abc', COUNT) === 30);
}

section('2 取整');
{
  check('默认只允许整数', resolveNumberInput('12.9', {}) === 12, resolveNumberInput('12.9', {}));
  check('integer: false 保留小数', resolveNumberInput('12.5', { integer: false }) === 12.5);
  check('负数向下取整到 0', resolveNumberInput('-0.5', {}) === 0, resolveNumberInput('-0.5', {}));
}

section('3 夹到 min / max');
{
  check('低于 min 被抬到 min', resolveNumberInput('0', COUNT) === 1, resolveNumberInput('0', COUNT));
  check('高于 max 被压到 max', resolveNumberInput('999', COUNT) === 200, resolveNumberInput('999', COUNT));
  check('区间内保持原值', resolveNumberInput('42', COUNT) === 42);
  check('负数被抬到 min', resolveNumberInput('-5', { min: 1 }) === 1);
  check('只给 max 时也生效', resolveNumberInput('99', { max: 10 }) === 10);
}

section('4 回退值');
{
  check('用指定的 fallback', numberInputFallback({ min: 1, max: 200, fallback: 30 }) === 30);
  check('没有 fallback 时用 min', numberInputFallback({ min: 5 }) === 5);
  check('什么都没有时是 0', numberInputFallback() === 0);
  check('fallback 低于 min 会被抬上来', numberInputFallback({ min: 5, fallback: 2 }) === 5);
  check('fallback 高于 max 会被压下去', numberInputFallback({ max: 10, fallback: 99 }) === 10);
  check('fallback 也按整数取整', numberInputFallback({ fallback: 7.8 }) === 7);
}

section('5 合法输入不被改写');
{
  check('条数 30 原样通过', resolveNumberInput('30', COUNT) === 30);
  check('带前后空格也能识别', resolveNumberInput(' 45 ', COUNT) === 45);
  check('科学计数法按数字处理', resolveNumberInput('1e3', {}) === 1000, resolveNumberInput('1e3', {}));
  check('加号前缀也能识别', resolveNumberInput('+8', {}) === 8, resolveNumberInput('+8', {}));
}

// ---------------------------------------------------------------------------
section('6 面板外观 (垫底色 / 不透明度 / 模糊半径)');
{
  check('默认外观有垫底色', defaultPanelLook().垫底色 === DEFAULT_PANEL_TINT, defaultPanelLook());
  check('默认外观有模糊半径', defaultPanelLook().模糊半径 === DEFAULT_PANEL_BLUR);
  check('node 下读取返回默认值', loadPanelLook().不透明度 === DEFAULT_PANEL_ALPHA, loadPanelLook());

  check('六位色值归一为小写带井号', normalizeHex('#AABBCC') === '#aabbcc', normalizeHex('#AABBCC'));
  check('可以省略井号', normalizeHex('0e1015') === '#0e1015');
  check('三位缩写会展开', normalizeHex('#abc') === '#aabbcc', normalizeHex('#abc'));
  check('前后空格被忽略', normalizeHex('  #123456  ') === '#123456');
  check('非色值返回 null', normalizeHex('红色') === null && normalizeHex('') === null && normalizeHex(null) === null);

  check('色值转 rgb 分量', hexToRgbParts('#0e1015') === '14 16 21', hexToRgbParts('#0e1015'));
  check('转 rgb 时非法色值回退默认', hexToRgbParts('xx') === hexToRgbParts(DEFAULT_PANEL_TINT));

  const parsed = PanelLookSchema.parse({ 垫底色: 'ABC', 不透明度: '0.4', 模糊半径: '99' });
  check('解析时色值被归一', parsed.垫底色 === '#aabbcc', parsed.垫底色);
  check('字符串数字能解析', parsed.不透明度 === 0.4, parsed.不透明度);
  check('模糊半径被夹到上限', parsed.模糊半径 === MAX_PANEL_BLUR, parsed.模糊半径);
  check('不透明度被夹到 0~1', PanelLookSchema.parse({ 不透明度: 3 }).不透明度 === 1);
  check('模糊半径不为负', PanelLookSchema.parse({ 模糊半径: -5 }).模糊半径 === 0);
  check('非法数值回退默认', PanelLookSchema.parse({ 不透明度: 'abc' }).不透明度 === DEFAULT_PANEL_ALPHA);
  check('缺字段时补默认值', PanelLookSchema.parse({}).垫底色 === DEFAULT_PANEL_TINT);

  const style = panelLookStyle({ 垫底色: '#0e1015', 不透明度: 0.5, 模糊半径: 12 });
  check('样式带 tint 变量', style['--panel-tint'] === '14 16 21', style);
  check('样式带 alpha 变量', style['--panel-alpha'] === '0.5', style);
  check('样式带 blur 变量', style['--panel-blur'] === '12px', style);
  check('样式带遮罩变量', style['--panel-mask'].startsWith('rgb('), style);

  check('描述包含色值与模糊', describePanelLook({ 垫底色: '#0e1015', 不透明度: 0.6, 模糊半径: 8 }).includes('8px'));

  const saved = savePanelLook({ 垫底色: '#112233', 模糊半径: 6 });
  check('保存后立即生效', saved.垫底色 === '#112233' && loadPanelLook().模糊半径 === 6, saved);
  check('保存后旧字段保留', loadPanelLook().不透明度 === DEFAULT_PANEL_ALPHA);
  check('保存非法值会被归一', savePanelLook({ 垫底色: 'nope' }).垫底色 === DEFAULT_PANEL_TINT);
  check('恢复默认', resetPanelLook().垫底色 === DEFAULT_PANEL_TINT && loadPanelLook().模糊半径 === DEFAULT_PANEL_BLUR);

  let notified = 0;
  const off = onPanelLookChanged(() => {
    notified += 1;
  });
  savePanelLook({ 模糊半径: 14 });
  off();
  savePanelLook({ 模糊半径: 15 });
  check('订阅者收到一次通知', notified === 1, notified);
  flushPanelLookSave();
}

// ---------------------------------------------------------------------------
section('7 数据体积 (UTF-8 字节数 + B / KiB / MiB)');
{
  check('空值体积为 0', jsonBytes(null) === 4 && jsonBytes(undefined) === 0);
  check('中文按 UTF-8 字节算 (1 字 = 3 字节)', jsonBytes('卡') === 5, jsonBytes('卡'));
  check('数组体积含方括号', jsonBytes([]) === 2 && jsonBytes([1]) === 3);
  check('对象键值都算进去', jsonBytes({ a: 1 }) === 7, jsonBytes({ a: 1 }));
  check('不可序列化的值返回 0', jsonBytes(() => 1) === 0);

  check('formatSize: 零', formatSize(0) === '0');
  check('formatSize: 不足 1 KiB 按字节', formatSize(999) === '999 B');
  check('formatSize: 1 KiB 起换成 KiB', formatSize(1536) === '1.5 KiB', formatSize(1536));
  check('formatSize: 1 MiB 起换成 MiB', formatSize(2.5 * 1024 * 1024) === '2.50 MiB', formatSize(2.5 * 1024 * 1024));
  check('formatSize: 非法值按 0 处理', formatSize(-1) === '0' && formatSize(Number.NaN) === '0');
}

console.log(`\n通过 ${passed} 项, 失败 ${failed} 项`);
if (failed > 0) {
  process.exitCode = 1;
}
