// AI 辅助写卡 - 测试脚本 (不联网, 只测提示词、接口设置映射与输出解析)
//
// 运行: node src/卡牌系统/AI/测试.ts

import { parseMachineEffect } from '../引擎/schema.ts';
import { CardSchema, type Card } from '../卡牌/schema.ts';
import { cardContentKey } from '../卡牌/去重.ts';
import { aiGenerate, aiGenerateJson, aiStopAll, isAiAvailable } from './客户端.ts';
import {
  AiCardSchema,
  extractCodeBlock,
  extractFirstJson,
  normalizeAiCard,
  normalizeAiDeck,
  parseAiJson,
} from './解析.ts';
import { 卡牌写作规范, 输出约定, 机读规范, 用户优先规范 } from './规范.ts';
import {
  PROMPT_ENTRIES,
  PROMPT_KEYS,
  PROMPT_TEXT_LIMIT,
  applyPromptOverrides,
  isPromptCustomized,
  promptDefault,
  promptOverrides,
  promptText,
  promptTextFilled,
  savePromptOverrides,
  渲染模板,
} from './提示词.ts';
import {
  AiSettingsSchema,
  aiSettingsIssue,
  defaultAiSettings,
  describeAiSettings,
  listProxyPresets,
  loadAiSettings,
  toCustomApi,
} from './设置.ts';
import { describeCard, describeDeck, 卡组请求, 卡牌请求 } from './任务.ts';

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

function makeCard(partial: Partial<Card> & { name: string }): Card {
  return CardSchema.parse({
    id: `card-${partial.name}`,
    rarity: 'R',
    type: '从者',
    ...partial,
  });
}

// ---------------------------------------------------------------------------
section('0 规范文本');
{
  check('机读规范包含顶层写法', 机读规范.includes('effects') && 机读规范.includes('operations'));
  check(
    '机读规范包含全部触发时点',
    ['MANUAL', 'TURN_END', 'AFTER_ATTACK', 'ON_RECYCLE'].every(token => 机读规范.includes(token)),
  );
  check(
    '机读规范包含换边与行动时点',
    ['SIDE_START', 'SIDE_END', 'SIDE_CHANGE'].every(token => 机读规范.includes(token)),
  );
  check(
    '机读规范说明一个回合 = 双方各行动一次',
    机读规范.includes('双方各行动一次') && 机读规范.includes('双方都行动完后才开始回合结算'),
  );
  check('机读规范说明 TURN_START/TURN_END 没有归属方', 机读规范.includes('没有归属方'));
  check(
    '机读规范包含关键操作',
    ['DAMAGE', 'APPLY_STATUS', 'MODIFY', 'SUMMON', 'SET_FLAG'].every(token => 机读规范.includes(token)),
  );
  check('机读规范包含目标关键字', 机读规范.includes('EVENT_TARGET') && 机读规范.includes('ALL_ENEMIES'));
  check('机读规范强调严格键名', 机读规范.includes('严格模式'));
  check('卡牌写作规范包含稀有度枚举', 卡牌写作规范.includes('"UR"'));
  check('写作规范要求多条效果换行', 卡牌写作规范.includes('每条效果单独一行') && 卡牌写作规范.includes('用换行符隔开'));
  check('写作规范给出 \\n 写法', 卡牌写作规范.includes('\\n'));
  check('输出约定要求纯 JSON', 输出约定.includes('JSON'));
  check('输出约定要求换行写成转义', 输出约定.includes('换行必须写成'));

  // 第一原则: 用户要什么就给什么 (不是数值游戏, 不追求对战平衡)
  check('用户优先规范表明用户说了算', 用户优先规范.includes('用户说了算') && 用户优先规范.includes('优先'));
  check('用户优先规范否定对战平衡', 用户优先规范.includes('数值游戏') && 用户优先规范.includes('不需要对战平衡'));
  check('写作规范说明数值参考只是默认档位', 卡牌写作规范.includes('不是上限'));
  check('机读规范包含破盾时点与穿盾', 机读规范.includes('SHIELD_BROKEN') && 机读规范.includes('pierce'));
  check(
    '机读规范讲清守卫与溢出传伤',
    机读规范.includes('ignore_guard') &&
      机读规范.includes('守卫') &&
      机读规范.includes('溢出') &&
      机读规范.includes('DAMAGE'),
  );
  check(
    '机读规范包含 ask / ask_default',
    机读规范.includes('ask_default') && 机读规范.includes('先问一下') && 机读规范.includes('"RUN" | "SKIP"'),
  );
  check(
    '机读规范提醒不要滥用 ask',
    机读规范.includes('千万不要写 ask') && 机读规范.includes('ask_default: "SKIP"'),
  );
  check(
    '写作规范包含能量字段',
    卡牌写作规范.includes('energy') && 卡牌写作规范.includes('上场消耗的能量') && 卡牌写作规范.includes('不花能量'),
  );

  // 值表达式 / 变量 / 控制流 (引擎新能力, 规范必须讲清楚否则 AI 不会用)
  check(
    '机读规范说明数值可以是公式或结构化对象',
    机读规范.includes('公式字符串') && 机读规范.includes('"op"') && 机读规范.includes('数值'),
  );
  check(
    '机读规范给出公式示例与可用函数',
    ['SELF.atk / 2', 'SUM(', 'COUNT(', 'RANDOM', 'TURN', '$变量名'].every(token => 机读规范.includes(token)),
  );
  check(
    '机读规范区分聚合 MAX(全场) 与普通 MAX(取大)',
    机读规范.includes('MAX(SELF.atk, 400)') && 机读规范.includes('聚合'),
  );
  check(
    '机读规范包含新操作与循环体目标',
    ['SET_VAR', 'ADD_VAR', 'IF', 'FOR_EACH', 'REPEAT', 'BREAK', 'STOP', 'LOOP_ITEM', '$index', '$round'].every(
      token => 机读规范.includes(token),
    ),
  );
  check(
    '机读规范说明变量作用域',
    机读规范.includes('"EFFECT"') && 机读规范.includes('"BATTLE"') && 机读规范.includes('跨回合'),
  );
  check(
    '机读规范写明失控上限',
    机读规范.includes('32 个目标') && 机读规范.includes('64 轮') && 机读规范.includes('800 个操作'),
  );
  check('机读规范包含 var / target 条件', 机读规范.includes('"var"') && 机读规范.includes('"target"'));
  check(
    '机读规范提醒常驻修正里的公式只算一次',
    机读规范.includes('被创建时') && 机读规范.includes('ADD_EFFECT'),
  );
}

// ---------------------------------------------------------------------------
section('1 代码块与 JSON 提取');
{
  const fenced = '好的, 这是结果:\n```json\n{"a": 1}\n```\n希望有帮助';
  check('取出代码块内容', extractCodeBlock(fenced) === '{"a": 1}', extractCodeBlock(fenced));
  check('无代码块时返回原文', extractCodeBlock('{"a": 1}').trim() === '{"a": 1}');

  check('截取第一个 JSON 对象', extractFirstJson('前言 {"a": {"b": 2}} 后记') === '{"a": {"b": 2}}');
  check('截取第一个 JSON 数组', extractFirstJson('x [1, [2, 3]] y') === '[1, [2, 3]]');
  check(
    '字符串里的括号不影响匹配',
    extractFirstJson('{"a": "}{"}') === '{"a": "}{"}',
    extractFirstJson('{"a": "}{"}'),
  );
  check('转义引号不影响匹配', extractFirstJson('{"a": "\\""}') === '{"a": "\\""}');
  check('没有 JSON 时返回 null', extractFirstJson('没有结构') === null);
}

// ---------------------------------------------------------------------------
section('2 宽松解析');
{
  check('标准 JSON', (parseAiJson('{"a": 1}') as any).a === 1);
  check('代码块包裹', (parseAiJson('```json\n{"a": 2}\n```') as any).a === 2);
  check('前后有解释文字', (parseAiJson('结果如下 {"a": 3} 完毕') as any).a === 3);
  check('尾逗号修复', (parseAiJson('{"a": 4,}') as any).a === 4);
  check('单引号 (JSON5)', (parseAiJson("{'a': 5}") as any).a === 5);
  check('嵌套对象', (parseAiJson('{"a": {"b": [1, 2]}}') as any).a.b.length === 2);

  let threw = false;
  try {
    parseAiJson('完全不是 JSON');
  } catch {
    threw = true;
  }
  check('无法解析时抛错', threw);
}

// ---------------------------------------------------------------------------
section('3 单卡规范化');
{
  const card = normalizeAiCard(
    {
      name: ' 愿之芽 ',
      rarity: '不存在的稀有度',
      stars: '3',
      atk: 300,
      shield: null,
      hp: 1500,
      description: '测试',
      machine_effect: '{"modifiers":[{"stat":"atk","value":100}]}',
    },
    '敌方',
  );
  check('卡名去空格', card.name === '愿之芽', card.name);
  check('阵营被强制为传入值', card.阵营 === '敌方', card.阵营);
  check('非法稀有度退回 N', card.rarity === 'N', card.rarity);
  check('星数由字符串转数字', card.stars === 3, card.stars);
  check('数值转字符串', card.atk === '300', card.atk);
  check('null 数值转空字符串', card.shield === '', card.shield);
  check('机读字符串被解析为对象', parseMachineEffect(card.machine_effect).error === null);
  check('缺失字段有默认值', card.type === '从者' && card.series === '');

  const empty_effect = normalizeAiCard({ name: '无效果', machine_effect: '' }, '通用');
  check('空机读字符串被移除', empty_effect.machine_effect === undefined);

  const bad_effect = normalizeAiCard({ name: '坏机读', machine_effect: '不是 JSON' }, '通用');
  check('无法解析的机读字符串被丢弃', bad_effect.machine_effect === undefined);

  let name_threw = false;
  try {
    normalizeAiCard({ series: '无名' }, '我方');
  } catch {
    name_threw = true;
  }
  check('缺卡名时抛错', name_threw);

  check('AiCardSchema 可直接解析', AiCardSchema.safeParse({ name: 'x' }).success);
}

// ---------------------------------------------------------------------------
section('4 卡组规范化');
{
  const deck = normalizeAiDeck(
    {
      名称: ' 炎龙军团 ',
      备注: '测试用',
      卡牌: [
        { name: 'A', 数量: 2 },
        { name: 'B' },
        { name: '' },
        { name: 'C', 数量: 99 },
      ],
    },
    '敌方',
  );
  check('卡组名去空格', deck.名称 === '炎龙军团', deck.名称);
  check('数量展开', deck.卡牌.filter(card => card.name === 'A').length === 2);
  check('无数量默认 1 份', deck.卡牌.filter(card => card.name === 'B').length === 1);
  check('数量上限 3', deck.卡牌.filter(card => card.name === 'C').length === 3);
  check('无卡名的卡被跳过并警告', deck.卡牌.every(card => card.name) && deck.warnings.length === 1, deck.warnings);
  check('阵营统一为敌方', deck.卡牌.every(card => card.阵营 === '敌方'));

  const common_deck = normalizeAiDeck({ 卡牌: [{ name: '通用卡', 数量: 2 }] }, '通用');
  check('传通用时卡牌阵营为通用', common_deck.卡牌.every(card => card.阵营 === '通用'), common_deck.卡牌);
  check('通用卡组名默认带通用', common_deck.名称.includes('通用'), common_deck.名称);

  const limited = normalizeAiDeck({ 卡牌: [{ name: 'X', 数量: 3 }, { name: 'Y', 数量: 3 }] }, '敌方', { limit: 4 });
  check('总张数受 limit 限制', limited.卡牌.length === 4, limited.卡牌.length);
  check('超限时有警告', limited.warnings.some(text => text.includes('上限')));

  let deck_threw = false;
  try {
    normalizeAiDeck({ 卡牌: [] }, '敌方');
  } catch {
    deck_threw = true;
  }
  check('空卡组抛错', deck_threw);

  // 模型忽略 json_schema 时的常见写法: 英文键名 / 外层包装 / 裸数组
  const english = normalizeAiDeck({ cards: [{ name: 'A', quantity: 3 }, { name: 'B' }] }, '我方');
  check('识别 cards 键', english.卡牌.length === 4, english.卡牌.length);
  check('识别 quantity 份数', english.卡牌.filter(card => card.name === 'A').length === 3);
  check('缺份数时默认 1', english.卡牌.filter(card => card.name === 'B').length === 1);
  check('英文包装也能取卡组名', normalizeAiDeck({ name: '我的卡组', cards: [{ name: 'A' }] }, '我方').名称 === '我的卡组');
  check('英文包装也能取备注', normalizeAiDeck({ note: 'hi', cards: [{ name: 'A' }] }, '敌方').备注 === 'hi');
  check('卡组名默认带阵营', normalizeAiDeck({ cards: [{ name: 'A' }] }, '我方').名称 === 'AI 我方卡组');
  check('裸数组也能解析', normalizeAiDeck([{ name: 'A', count: 2 }], '敌方').卡牌.length === 2);
  check('嵌套卡组包装能解析', normalizeAiDeck({ 卡组: { 卡牌: [{ name: 'A' }] } }, '敌方').卡牌.length === 1);
  check(
    '中文键名卡牌能解析',
    normalizeAiDeck(
      { 卡牌: [{ 卡名: '甲', 稀有度: 'UR', 攻击: '100', 护盾: '50', 生命: '500', 效果描述: 'x' }] },
      '敌方',
    ).卡牌[0].rarity === 'UR',
  );
  check(
    '旧提示词的「防御」也会当成护盾',
    normalizeAiDeck({ 卡牌: [{ 卡名: '乙', 防御: '80', 生命: '500' }] }, '敌方').卡牌[0].shield === '80',
    normalizeAiDeck({ 卡牌: [{ 卡名: '乙', 防御: '80', 生命: '500' }] }, '敌方').卡牌[0],
  );
  check(
    '中文键名映射到英文',
    (() => {
      const card = normalizeAiDeck({ 卡牌: [{ 卡名: '甲', 攻击: '100', 生命: '500' }] }, '敌方').卡牌[0];
      return card.name === '甲' && card.atk === '100' && card.hp === '500';
    })(),
  );
  check('card 外壳能解析', normalizeAiCard({ card: { name: '包' } }, '通用').name === '包');
}

// ---------------------------------------------------------------------------
section('4.5 真实返回样本 (模型忽略 json_schema, 用了 cards / quantity)');
{
  // 取自一次真实失败的返回: 顶层是 {"cards": [...]}, 份数字段叫 quantity
  const sample = {
    cards: [
      {
        name: '回响·愿望之芽',
        series: '回响',
        rarity: 'N',
        stars: 1,
        type: '从者',
        atk: '300',
        shield: '150',
        hp: '1500',
        description: '此卡存在场上两回合时, 所有水属性卡牌 ATK+100',
        machine_effect: {
          effects: [
            {
              id: 'wish_sprout_atk_boost',
              condition: { self: { zone: 'FIELD', turns_in_zone: 2 } },
              modifiers: [{ stat: 'atk', layer: 'ADD', value: 100, target: 'SELF' }],
              limit: { per: 'BATTLE', times: 1 },
            },
          ],
        },
        quantity: 3,
      },
      {
        name: '开拓·遐蝶',
        series: '开拓',
        rarity: 'SR',
        stars: 4,
        type: '从者',
        atk: '500',
        shield: '200',
        hp: '4000',
        description: '攻击附带纠缠; 下场时转移 HP',
        machine_effect: {
          effects: [
            {
              id: 'entangle',
              on: 'AFTER_ATTACK',
              operations: [
                {
                  type: 'APPLY_STATUS',
                  target: 'EVENT_TARGET',
                  status: 'entangle',
                  name: '纠缠',
                  value: 1,
                  duration: { turns: 2, tick_on: 'TURN_START', tick_owner: 'OPPONENT' },
                  effects: [
                    {
                      on: 'TURN_START',
                      when: 'CONTROLLER',
                      operations: [{ type: 'DAMAGE', target: 'SELF', value: 50 }],
                    },
                  ],
                },
              ],
            },
            {
              id: 'mourning',
              on: 'ON_LEAVE',
              operations: [{ type: 'HEAL', target: { zone: 'FIELD', controller: 'SELF', max: 1 }, value: 2000 }],
            },
          ],
        },
        quantity: 1,
      },
    ],
  };
  const deck = normalizeAiDeck(sample, '我方');
  check('真实样本能解析出 4 张', deck.卡牌.length === 4, deck.卡牌.length);
  check('真实样本保留 quantity 份数', deck.卡牌.filter(card => card.name === '回响·愿望之芽').length === 3);
  check(
    '真实样本 4 张只对应 2 种卡牌 (写入卡牌库时只建两张)',
    new Set(deck.卡牌.map(card => cardContentKey(card))).size === 2,
    deck.卡牌.map(card => card.name),
  );
  // 老卡里容易残留 tick_owner: 仍然要能解析 (引擎只是忽略它)
  check(
    '旧写法 duration.tick_owner 仍能解析',
    deck.卡牌.some(card => JSON.stringify(card.machine_effect ?? '').includes('tick_owner')),
  );
  check(
    '真实样本机读效果都能通过校验',
    deck.卡牌.every(card => parseMachineEffect(card.machine_effect).error === null),
    deck.卡牌.map(card => parseMachineEffect(card.machine_effect).error),
  );
}

// ---------------------------------------------------------------------------
section('5 提示词摘要');
{
  const card = makeCard({
    name: '愿之芽',
    series: '祈愿',
    rarity: 'UR',
    stars: 5,
    atk: '300',
    shield: '150',
    hp: '1500',
    description: '己方墓地有炎龙时攻击力提升',
    machine_effect: { modifiers: [{ stat: 'atk', value: 100 }] },
  });
  const text = describeCard(card);
  check('摘要含卡名', text.includes('愿之芽'));
  check('摘要含数值', text.includes('300') && text.includes('1500'));
  check('摘要含效果描述', text.includes('己方墓地有炎龙时攻击力提升'));
  check('摘要含机读效果', text.includes('modifiers'));
  check('摘要写能量', describeCard(makeCard({ name: '燎原', energy: '4' })).includes('能量: 4'));
  check('没有能量的卡不写能量', describeCard(makeCard({ name: '小火' })).includes('能量') === false);

  const deck_text = describeDeck([card, card, makeCard({ name: '小火', rarity: 'N', atk: '100', hp: '500' })]);
  check('卡组摘要含总张数', deck_text.includes('总张数: 3'), deck_text.split('\n')[0]);
  check('卡组摘要含稀有度分布', deck_text.includes('UR×2') && deck_text.includes('N×1'));
  check('卡组摘要合并同名卡', deck_text.includes('愿之芽 ×2'));
  check('空卡组有占位文本', describeDeck([]) === '(空卡组)');

  // 多份合并: 4 张同卡只写一行「×4」, 不把摘要重复 4 遍浪费 token
  const four = describeDeck([card, card, card, card]);
  const four_lines = four.split('\n').filter(line => line.startsWith('- '));
  check('同卡 4 份只占一行', four_lines.length === 1, four_lines);
  check('同卡 4 份标为 ×4', four.includes('愿之芽 ×4'), four_lines[0]);
  check('同卡 4 份仍报总张数 4', four.includes('总张数: 4'));
  check('同卡 4 份不重复卡名', (four.match(/愿之芽/g) ?? []).length === 1, four);

  // 同名但 id 不同的卡不能错并成一条 (否则数值只取到第一张)
  const same_name_a = makeCard({ id: 'card-a', name: '双生', atk: '100', hp: '500' });
  const same_name_b = makeCard({ id: 'card-b', name: '双生', atk: '900', hp: '900' });
  const same_name_text = describeDeck([same_name_a, same_name_b]);
  check('同名不同卡分两行', same_name_text.split('\n').filter(line => line.startsWith('- ')).length === 2);
  check('同名不同卡各自带数值', same_name_text.includes('ATK 100') && same_name_text.includes('ATK 900'));
}

// ---------------------------------------------------------------------------
section('5.5 生成请求构造 (上下文开关 / 追加模式)');
{
  const card = makeCard({ name: '愿之芽', rarity: 'UR', atk: '300', hp: '1500' });

  const no_ctx = 卡牌请求({ 阵营: '我方', 需求: '一张治疗卡' });
  check('生成单卡默认不带上下文', no_ctx.with_history === undefined && no_ctx.max_chat_history === undefined, no_ctx);
  check('生成单卡带目标阵营', no_ctx.context?.includes('我方') === true);
  check('生成单卡带需求', no_ctx.context?.includes('一张治疗卡') === true);
  check(
    '生成单卡提示词含 energy 字段',
    no_ctx.system?.includes('"energy"') === true && 卡组请求({ 阵营: '我方', 张数: 3 }).system?.includes('"energy"') === true,
  );
  check('生成单卡的提示词以用户优先开头', no_ctx.system?.startsWith(用户优先规范) === true, no_ctx.system?.slice(0, 40));
  check('生成单卡把需求标为最高优先级', no_ctx.context?.includes('【需求 (最高优先级)】') === true, no_ctx.context);

  const with_ctx = 卡牌请求({ 阵营: '敌方', 需求: '', 参考卡: card, 带入上下文: true, 历史条数: 12 });
  check('打开上下文后带聊天历史', with_ctx.with_history === true && with_ctx.max_chat_history === 12, with_ctx);
  check('打开上下文时提示词提到聊天记录', with_ctx.system?.includes('聊天记录') === true);
  check('参考卡写进上下文', with_ctx.context?.includes('愿之芽') === true);
  check('聊天条数被限制在 200', 卡牌请求({ 阵营: '我方', 需求: '', 带入上下文: true, 历史条数: 9999 }).max_chat_history === 200);

  const deck_new = 卡组请求({ 阵营: '敌方', 参考卡组: [card], 张数: 8 });
  check('生成卡组默认带上下文', deck_new.with_history === true && deck_new.max_chat_history === 30, deck_new);
  check('生成卡组包含对手卡组', deck_new.context?.includes('对手卡组') === true && deck_new.context?.includes('愿之芽') === true);
  check('生成卡组的提示词以用户优先开头', deck_new.system?.startsWith(用户优先规范) === true, deck_new.system?.slice(0, 40));
  check('参考卡组说明以用户要求为准', deck_new.system?.includes('用户有要求时以用户为准') === true, deck_new.system);
  check('新建卡组不提示补充', deck_new.system?.includes('已经有一部分卡') !== true);
  check('张数写进提示词', deck_new.prompt.includes('8 张'), deck_new.prompt);
  check('张数上限 40', 卡组请求({ 阵营: '敌方', 张数: 99 }).prompt.includes('40 张'));

  const deck_append = 卡组请求({ 阵营: '我方', 已有卡组: [card], 张数: 5, 带入上下文: false, 需求: '多来点陷阱' });
  check('追加模式说明已有卡组', deck_append.system?.includes('已经有一部分卡') === true);
  check(
    '追加模式带已有卡组内容',
    deck_append.context?.includes('已有卡组') === true && deck_append.context?.includes('愿之芽') === true,
  );
  check('关闭上下文时不带聊天历史', deck_append.with_history === undefined && deck_append.max_chat_history === undefined, deck_append);
  check('关闭上下文时提示词不提聊天记录', deck_append.system?.includes('聊天记录') !== true);
  check('提示 AI 用数量表示份数', deck_append.system?.includes('「数量」') === true);
  check('追加模式把用户要求标为最高优先级', deck_append.context?.includes('【用户要求 (最高优先级)】') === true, deck_append.context);

  // 已有卡组里同一张卡 4 份 → 上下文只写一次「×4」, 不重复 4 行
  const deck_four = 卡组请求({ 阵营: '我方', 已有卡组: [card, card, card, card], 张数: 5, 带入上下文: false });
  check('已有卡组 4 份只写一行', (deck_four.context?.match(/愿之芽/g) ?? []).length === 1, deck_four.context);
  check('已有卡组 4 份标为 ×4', deck_four.context?.includes('愿之芽 ×4') === true, deck_four.context);

  // 卡牌阵营: 卡组仍是「敌方」, 但生成的卡牌双方都能用
  const deck_common = 卡组请求({ 阵营: '敌方', 卡牌阵营: '通用', 张数: 6, 带入上下文: false });
  check('通用卡组提示词写明卡牌阵营', deck_common.system?.includes('【生成的卡牌阵营】通用') === true, deck_common.system);
  check('通用卡组提示词说明双方都能用', deck_common.system?.includes('双方都能使用') === true, deck_common.system);
  const deck_own = 卡组请求({ 阵营: '敌方', 张数: 6, 带入上下文: false });
  check('默认卡牌阵营跟随卡组阵营', deck_own.system?.includes('【生成的卡牌阵营】敌方') === true, deck_own.system);
  check(
    '未传卡牌阵营时不提通用',
    卡组请求({ 阵营: '我方', 张数: 6, 带入上下文: false }).system?.includes('双方都能使用') !== true,
  );
}

// ---------------------------------------------------------------------------
section('6 写卡 AI 接口设置');
{
  const base = defaultAiSettings();
  check('默认模式为当前', base.模式 === '当前', base.模式);
  check('默认不覆盖接口', toCustomApi(base) === undefined, toCustomApi(base));
  check('默认描述为当前接口', describeAiSettings(base) === '酒馆当前接口', describeAiSettings(base));
  check('默认没有配置问题', aiSettingsIssue(base) === '', aiSettingsIssue(base));

  const preset = AiSettingsSchema.parse({ 模式: '预设', 预设名: '便宜写卡' });
  const preset_api = toCustomApi(preset);
  check('预设模式用 proxy_preset', preset_api?.proxy_preset === '便宜写卡', preset_api);
  check('预设模式不带 apiurl', preset_api?.apiurl === undefined, preset_api);
  check('预设模式描述含预设名', describeAiSettings(preset).includes('便宜写卡'), describeAiSettings(preset));

  const preset_model = AiSettingsSchema.parse({ 模式: '预设', 预设名: '便宜写卡', 模型: 'gpt-4o-mini' });
  check('预设模式可覆盖模型', toCustomApi(preset_model)?.model === 'gpt-4o-mini', toCustomApi(preset_model));

  const preset_empty = AiSettingsSchema.parse({ 模式: '预设' });
  check('预设未选名时不覆盖接口', toCustomApi(preset_empty) === undefined, toCustomApi(preset_empty));
  check('预设未选名时提示', aiSettingsIssue(preset_empty).includes('预设名'), aiSettingsIssue(preset_empty));

  const custom = AiSettingsSchema.parse({
    模式: '自定义',
    接口地址: 'https://api.example.com/v1',
    密钥: 'sk-test',
    模型: 'gpt-4o-mini',
    接口类型: 'openai',
  });
  const custom_api = toCustomApi(custom);
  check('自定义模式带地址', custom_api?.apiurl === 'https://api.example.com/v1', custom_api);
  check('自定义模式带密钥', custom_api?.key === 'sk-test', custom_api);
  check('自定义模式带模型', custom_api?.model === 'gpt-4o-mini', custom_api);
  check('自定义模式带类型', custom_api?.source === 'openai', custom_api);
  check('自定义模式描述含域名', describeAiSettings(custom).includes('api.example.com'), describeAiSettings(custom));

  const custom_no_key = AiSettingsSchema.parse({ 模式: '自定义', 接口地址: 'https://api.example.com/v1' });
  check('自定义可省密钥', toCustomApi(custom_no_key)?.key === undefined, toCustomApi(custom_no_key));
  check('自定义类型默认 openai', toCustomApi(custom_no_key)?.source === 'openai', toCustomApi(custom_no_key));

  const custom_empty = AiSettingsSchema.parse({ 模式: '自定义' });
  check('自定义未填地址时不覆盖接口', toCustomApi(custom_empty) === undefined, toCustomApi(custom_empty));
  check('自定义未填地址时提示', aiSettingsIssue(custom_empty).includes('接口地址'), aiSettingsIssue(custom_empty));

  const tuned = AiSettingsSchema.parse({ 模式: '当前', 温度: 1.2, 最大回复长度: 2048 });
  const tuned_api = toCustomApi(tuned);
  check('温度可覆盖当前接口', tuned_api?.temperature === 1.2, tuned_api);
  check('回复长度映射到 max_tokens', tuned_api?.max_tokens === 2048, tuned_api);

  check('温度超范围被拒绝', !AiSettingsSchema.safeParse({ 温度: 5 }).success);
  check('未知模式被拒绝', !AiSettingsSchema.safeParse({ 模式: '不存在' }).success);
  check('缺字段时补默认值', AiSettingsSchema.parse({}).模式 === '当前');
  check('node 下读取设置返回默认', loadAiSettings().模式 === '当前', loadAiSettings());
  check('node 下预设列表为空', listProxyPresets().length === 0);
}

// ---------------------------------------------------------------------------
section('6.5 提示词查看与自定义');
{
  check('条目键与 PROMPT_KEYS 一一对应', PROMPT_ENTRIES.map(item => item.key).join(',') === PROMPT_KEYS.join(','));
  check('每条都有标题', PROMPT_ENTRIES.every(item => item.标题.trim().length > 0));
  check('每条都有说明', PROMPT_ENTRIES.every(item => item.说明.trim().length > 0));
  check('每条默认文本都不空', PROMPT_ENTRIES.every(item => item.默认.trim().length > 0));
  check(
    '关键条目已标出机读规范与三个任务说明',
    PROMPT_ENTRIES.filter(item => item.关键).map(item => item.key).join(',') === '机读规范,卡牌任务,卡组任务,机读任务',
  );
  check('长度上限是正数', PROMPT_TEXT_LIMIT > 0, PROMPT_TEXT_LIMIT);

  // 默认值 = 规范.ts 里的那四段, 一个字都不能差 (否则用户看到的和实际发的不是一回事)
  check('用户优先默认 = 用户优先规范', promptDefault('用户优先') === 用户优先规范);
  check('卡牌规范默认 = 卡牌写作规范', promptDefault('卡牌规范') === 卡牌写作规范);
  check('机读规范默认 = 机读规范', promptDefault('机读规范') === 机读规范);
  check('输出约定默认 = 输出约定', promptDefault('输出约定') === 输出约定);
  check('未自定义时 promptText = 默认', promptText('卡牌任务') === promptDefault('卡牌任务'));
  check('未自定义时标记为未改过', isPromptCustomized('卡牌任务') === false);

  // 占位符: 卡组任务里那几处 {{...}} 必须能被填上
  check('渲染模板会替换占位符', 渲染模板('本次{{方式}}共 {{张数}} 张', { 方式: '新增', 张数: 8 }) === '本次新增共 8 张');
  check('占位符两边空格也认', 渲染模板('{{ 张数 }}', { 张数: 3 }) === '3');
  check('没给值的占位符清成空', 渲染模板('a{{没有}}b') === 'ab');
  check('默认卡组任务带占位符', ['阵营', '卡牌阵营', '方式', '张数'].every(name => promptDefault('卡组任务').includes(`{{${name}}}`)));
  check(
    'promptTextFilled 会把卡组任务填好',
    promptTextFilled('卡组任务', { 阵营: '敌方', 卡牌阵营: '敌方', 方式: '', 张数: 6 }).includes('【任务】为一场卡牌战斗设计「敌方」卡组.'),
  );
  check(
    '默认卡组任务含张数说明',
    promptTextFilled('卡组任务', { 张数: 5 }).includes('总张数控制在 5 张左右'),
  );
}
{
  // 改过之后: 实际发出的提示词要跟着变 (而不是只存在界面里)
  applyPromptOverrides({ 用户优先: '【自定义开场白】先看用户要求.' });
  check('自定义后 promptText 返回自定义文本', promptText('用户优先') === '【自定义开场白】先看用户要求.');
  check('自定义后标记为已改', isPromptCustomized('用户优先') === true);
  check('没改的条目不受影响', promptText('机读规范') === 机读规范);
  check(
    '生成单卡用上了自定义开场白',
    卡牌请求({ 阵营: '我方', 需求: '' }).system?.startsWith('【自定义开场白】') === true,
    卡牌请求({ 阵营: '我方', 需求: '' }).system?.slice(0, 20),
  );

  applyPromptOverrides({ 卡组任务: '自写任务: {{阵营}} / {{张数}}' });
  const deck = 卡组请求({ 阵营: '敌方', 张数: 7, 带入上下文: false });
  check('生成卡组用上了自定义任务块', deck.system?.includes('自写任务: 敌方 / 7') === true, deck.system);
  check('自定义任务块之外的开场白回到默认', deck.system?.startsWith(用户优先规范) === true);
  check('动态说明行依然跟上 (不归提示词管)', deck.system?.includes('请从零设计一整套卡组') === true);

  // 规整: 只收已知键 + 非空字符串
  applyPromptOverrides({ 用户优先: '  ', 不存在的键: 'x', 机读规范: 42, 输出约定: '留白之前的内容' });
  check('空字符串不算自定义', isPromptCustomized('用户优先') === false);
  check('未知键被丢弃', Object.keys(promptOverrides()).join(',') === '输出约定', promptOverrides());
  check('非字符串被丢弃', isPromptCustomized('机读规范') === false);

  const kept = savePromptOverrides({ 卡牌任务: '自定义任务块' });
  check('node 下保存不报错且内存生效', kept.卡牌任务 === '自定义任务块' && promptText('卡牌任务') === '自定义任务块');
  check('保存会覆盖旧值', Object.keys(promptOverrides()).join(',') === '卡牌任务', promptOverrides());

  // 收尾: 恢复到全默认, 免得影响后面的用例
  applyPromptOverrides({});
  check('恢复默认后不再有自定义', Object.keys(promptOverrides()).length === 0 && isPromptCustomized('卡牌任务') === false);
  check('恢复默认后提示词回到原样', 卡牌请求({ 阵营: '我方', 需求: '' }).system?.startsWith(用户优先规范) === true);
}

// ---------------------------------------------------------------------------
// 客户端降级测试需要 await, 用立即执行函数包住, 避免依赖顶层 await
void (async () => {
  section('7 生成客户端降级');
  check('node 环境下无 generateRaw', !isAiAvailable());
  check('无 generateRaw 时中断不报错', aiStopAll() === 0);

  let threw = '';
  try {
    await aiGenerate({ prompt: 'x' });
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('无 generateRaw 时给出友好提示', threw.includes('酒馆助手'), threw);

  let json_threw = '';
  try {
    await aiGenerateJson({ prompt: 'x' });
  } catch (error) {
    json_threw = error instanceof Error ? error.message : String(error);
  }
  check('aiGenerateJson 同样友好报错', json_threw.includes('酒馆助手'), json_threw);

  console.log(`\n通过 ${passed} 项, 失败 ${failed} 项`);
  if (failed > 0) {
    process.exitCode = 1;
  }
})();
