// 卡牌数据完整性检查 - 测试脚本
//
// 运行: node src/卡牌系统/卡牌/测试.ts

import { CardSchema, type Card } from './schema.ts';
import { cardContentKey, indexCardsByContent } from './去重.ts';
import { cardIssueMap, cardIssues, hasCardIssues } from './校验.ts';

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

function makeCard(partial: Partial<Card> & { name?: string } = {}): Card {
  return CardSchema.parse({
    id: `card-${partial.name ?? 'x'}-${Math.random().toString(36).slice(2, 8)}`,
    rarity: 'R',
    type: '从者',
    ...partial,
  });
}

function fields(card: Card): string[] {
  return cardIssues(card).map(issue => issue.field);
}

// ---------------------------------------------------------------------------
section('1 完整 / 未填完');
{
  const full = makeCard({ name: '愿之芽', atk: '300', shield: '150', hp: '1500' });
  check('信息填完的卡没有问题', !hasCardIssues(full), cardIssues(full));

  const blank = makeCard({ name: '' });
  check('空卡标记卡名', fields(blank).includes('name'));
  check('空卡标记三项数值', ['atk', 'shield', 'hp'].every(field => fields(blank).includes(field)), fields(blank));

  const spell = makeCard({ name: '治疗之光', hp: '500' });
  check('只填 HP 的法术卡不算问题', !hasCardIssues(spell), cardIssues(spell));
}

// ---------------------------------------------------------------------------
section('2 数值');
{
  const text_atk = makeCard({ name: '怪卡', atk: '三百', shield: '100', hp: '100' });
  check('ATK 不是数字被标记', fields(text_atk).includes('atk'), cardIssues(text_atk));
  check('ATK 是数字时放行', !hasCardIssues(makeCard({ name: '正常', atk: '300[+100]', hp: '1' })));
  check('负数/小数也认', !hasCardIssues(makeCard({ name: '负卡', atk: '-10.5', hp: '1' })));
}

// ---------------------------------------------------------------------------
section('3 机读效果');
{
  const bad = makeCard({ name: '坏机读', atk: '1', hp: '1', machine_effect: { on: 'TURN_END', operations: [{ 操作: '不存在' }] } });
  check('机读效果用不了被标记', fields(bad).includes('machine_effect'), cardIssues(bad));

  const good = makeCard({
    name: '好机读',
    atk: '1',
    hp: '1',
    machine_effect: { modifiers: [{ stat: 'atk', value: 100 }] },
  });
  check('合法机读效果不算问题', !hasCardIssues(good), cardIssues(good));
  check('没有机读效果不算问题', !hasCardIssues(makeCard({ name: '无效果', atk: '1', hp: '1' })));
}

// ---------------------------------------------------------------------------
section('4 列表汇总');
{
  const ok_card = makeCard({ name: '正常', atk: '1', hp: '1' });
  const blank = makeCard({ name: '' });
  const map = cardIssueMap([ok_card, blank]);
  check('没有问题的卡不进表', !map.has(ok_card.id));
  check('有问题的卡进表', map.has(blank.id));
  check('同一原因只提示一次', map.get(blank.id)?.length === 2, map.get(blank.id));
}

// ---------------------------------------------------------------------------
section('5 内容指纹 (AI 生成卡组去重)');
{
  const base = {
    name: '愿望之芽',
    series: '回响',
    atk: '300',
    shield: '150',
    hp: '1500',
    machine_effect: { modifiers: [{ stat: 'atk', value: 100 }] },
  };
  const a = makeCard(base);
  const b = makeCard(base);
  check('同内容不同 id 指纹相同', cardContentKey(a) === cardContentKey(b));
  check('id 不参与指纹', cardContentKey(a) === cardContentKey({ ...a, id: 'other' }));
  check('created_at 不参与指纹', cardContentKey(a) === cardContentKey({ ...a, created_at: 123 }));
  check('阵营不参与指纹', cardContentKey(a) === cardContentKey({ ...a, 阵营: '敌方' }));
  check('改数值指纹不同', cardContentKey(a) !== cardContentKey(makeCard({ ...base, atk: '400' })));
  check(
    '改机读指纹不同',
    cardContentKey(a) !== cardContentKey(makeCard({ ...base, machine_effect: { modifiers: [{ stat: 'atk', value: 200 }] } })),
  );
  check(
    '机读键顺序不影响指纹',
    cardContentKey(makeCard({ ...base, machine_effect: { on: 'TURN_START', value: 1 } })) ===
      cardContentKey(makeCard({ ...base, machine_effect: { value: 1, on: 'TURN_START' } })),
  );
  check('首尾空白不影响指纹', cardContentKey(makeCard({ ...base, name: '  愿望之芽  ' })) === cardContentKey(a));
  const index = indexCardsByContent([a, b]);
  check('同内容只记住第一个 id', index.size === 1 && index.get(cardContentKey(a)) === a.id, [...index.values()]);
}

// ---------------------------------------------------------------------------
section('6 能量 (上场消耗, 缺省 0 费)');
{
  const no_energy = makeCard({ name: '老卡', atk: '300', hp: '1000' });
  check('旧卡不写能量也能解析成空串', no_energy.energy === '', no_energy.energy);
  check('空串视为 0 费, 不算问题', !hasCardIssues(no_energy));

  const cost = makeCard({ name: '贵卡', atk: '900', hp: '1500', energy: '4' });
  check('写了能量就是数字, 不算问题', !hasCardIssues(cost), cardIssues(cost));

  const bad = makeCard({ name: '乱写', atk: '1', hp: '1', energy: '四点' });
  check('能量不是数字被标记', fields(bad).includes('energy'), cardIssues(bad));

  check(
    '能量参与内容指纹 (同卡不同费不算同一张)',
    cardContentKey(cost) !== cardContentKey(makeCard({ name: '贵卡', atk: '900', hp: '1500', energy: '3' })),
  );
}

console.log(`\n通过 ${passed} 项, 失败 ${failed} 项`);
if (failed > 0) {
  process.exitCode = 1;
}
