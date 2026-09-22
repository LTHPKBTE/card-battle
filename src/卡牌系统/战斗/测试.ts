// 战斗 · AI 交互层 - 测试脚本
//
// 运行: node src/卡牌系统/战斗/测试.ts
// (node 24 直接执行 .ts; 引擎与战斗模块内部导入统一带 .ts 扩展名, 因此无需构建)
//
// 只测纯逻辑 (简报 / 决策 / 协议); 世界书.ts 与 同步.ts 依赖酒馆全局, 不在这里测.

import { activate, attack, createBattle, drawCards, endSide, listAskable, listAsks, playCard, startBattle } from '../引擎/battle.ts';
import { cardsInZone } from '../引擎/selectors.ts';
import { createCardProvider } from '../引擎/适配.ts';
import { 测试卡 } from '../引擎/测试卡.ts';
import type { BattleState, CardInstance, LogEntry, PlayerId } from '../引擎/types.ts';
import { buildBrief, renderBrief } from './简报.ts';
import {
  MAX_DECISION_OPS,
  applyDecision,
  applyDecisionText,
  executeOps,
  extractDecision,
} from './决策.ts';
import { buildPromptText, bothSidesNote, protocolText, PROTOCOL_VERSION } from './协议.ts';
import {
  DEFAULT_LOG_FILTER_KEYS,
  DEFAULT_LOG_QUERY,
  LOG_FILTER_GROUPS,
  LOG_FILTERS,
  LOG_KIND_LABELS,
  LOG_LEVEL_LABELS,
  collectBattleLogs,
  filterBattleLogs,
  filterLogs,
  isLogLevel,
  logCounts,
  matchLogKey,
  parseOpLine,
} from './日志.ts';
import { DEBUG_JSON_LIMIT, buildDebugSegments, collectBattleDebug, renderDebugPrompt } from './调试.ts';
import {
  REPLAY_KEEP_STEPS,
  REPLAY_STEP_LIMIT,
  cloneBattleState,
  compactReplay,
  fingerprintState,
  findStepIndex,
  hashText,
  inspectReplay,
  replayBattle,
  replaySize,
  renumberSteps,
  rewindCountFor,
  shiftAnchorsAfterDelete,
  stepMatchesFingerprint,
} from './回放.ts';
import { PLAYBACK_FRAME_LIMIT, buildBattlePlayback } from './播放.ts';
import {
  DEFAULT_ACTION_INTERVAL,
  DEFAULT_SETTLE_INTERVAL,
  MAX_BATTLE_INTERVAL,
  BattlePaceSchema,
  defaultBattlePace,
  describeInterval,
  loadBattlePace,
  onBattlePaceChanged,
  saveBattlePace,
} from './节奏.ts';
import {
  TIMING_LABELS,
  ZONE_LABELS,
  cardAuraNames,
  cardEffectRows,
  cardInfoRows,
  cardPoolRows,
  cardPositionRows,
  cardStatRows,
  cardStatusRows,
  cardTraceRows,
} from './详情.ts';
import {
  DEBUG_LEAF_LIMIT,
  SCOPE_META,
  buildNameLookup,
  buildScopeReport,
  describeValue,
  flattenLeaves,
} from '../调试/数据.ts';
import { jsonBytes } from '../共用/体积.ts';
import { BATTLE_AI_PATH, BATTLE_STORE_VERSION, BattleAIStoreSchema, BattleSetupSchema } from './schema.ts';
import type { ReplayStep } from './schema.ts';
import {
  BATTLE_ENTRY_NAME,
  BATTLE_WORLDBOOK_NAME,
  battleEntryContent,
  battleTavernEntry,
  battleWorldbookFile,
} from './世界书.ts';

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

const { provider } = createCardProvider(测试卡);

function handCard(state: BattleState, player: PlayerId, name: string): CardInstance {
  const card = cardsInZone(state, player, 'HAND').find(item => item.name === name);
  if (!card) {
    throw new Error(`${player} 手牌里没有「${name}」`);
  }
  return card;
}

function fieldCard(state: BattleState, player: PlayerId, name: string): CardInstance | null {
  return cardsInZone(state, player, 'FIELD').find(item => item.name === name) ?? null;
}

/**
 * 造一场「轮到 ENEMY」的战斗:
 * - ENEMY 场上: 愿之芽 (攻 500, 血 800)
 * - ENEMY 手牌: 研究笔记 / 战意 / 愿之芽
 * - PLAYER 场上: 愿之芽; PLAYER 手牌: 封印之匣
 */
function setup(): BattleState {
  const state = createBattle({
    card_provider: provider,
    player_deck: ['1', '10', '1', '1'],
    enemy_deck: ['1', '9', '13', '1', '1'],
    seed: 7,
    opening_hand: 0,
    first: 'ENEMY',
  });
  startBattle(state);
  drawCards(state, 'ENEMY', 99);
  drawCards(state, 'PLAYER', 99);
  playCard(state, handCard(state, 'ENEMY', '愿之芽').id);
  playCard(state, handCard(state, 'PLAYER', '愿之芽').id);
  return state;
}

// ---------------------------------------------------------------------------
section('0. 简报: 只给 AI 该看的信息');

{
  const state = setup();
  const brief = buildBrief(state, 'ENEMY');
  check('回合与行动方正确', brief.turn === 1 && brief.active === 'ENEMY' && brief.ai === 'ENEMY');
  check('AI 阵营与对手正确', brief.opponent === 'PLAYER');
  check('AI 场上读到 1 张卡', brief.ai_field.length === 1, brief.ai_field);
  check('对手场上读到 1 张卡', brief.opponent_field.length === 1, brief.opponent_field);
  check('AI 手牌 4 张', brief.ai_hand.length === 4, brief.ai_hand.map(card => card.name));
  check('场上卡已把 atk 修正算进去 (300 + 200)', brief.ai_field[0].atk === 500, brief.ai_field[0]);
  check('场上卡标记可攻击', brief.ai_field[0].can_attack === true);
  check('手牌里的研究笔记可上场', brief.playable.includes(handCard(state, 'ENEMY', '研究笔记').id));
  check('可发动效果为空 (研究笔记还在手牌)', brief.activatable.length === 0, brief.activatable);

  const text = renderBrief(brief);
  check('简报含回合与行动方', text.includes('回合 1') && text.includes('行动方 你(ENEMY)'), text);
  check('简报含双方生命', text.includes('你(ENEMY) HP 8000/8000') && text.includes('对手(PLAYER) HP 8000/8000'), text);
  check('简报含三类区域', text.includes('你的场上:') && text.includes('对手场上:') && text.includes('你的手牌:'), text);
  check('简报标记手牌可上场', text.includes('[可上场]'), text);
  check('简报标出数值变化量 (300 + 200)', text.includes('500(+200)'), text);
  check('简报不泄露对手手牌 (封印之匣)', !text.includes('封印之匣'), text);
  // 「战斗规则」里会合法地提到牌库 (洗牌), 所以只检查没有「牌库列表 / 牌库存牌」
  check('简报不含牌库列表', !text.includes('你的牌库') && !text.includes('牌库:'), text);
}

{
  // 研究笔记上场后才可发动
  const state = setup();
  const note = handCard(state, 'ENEMY', '研究笔记');
  playCard(state, note.id);
  const brief = buildBrief(state, 'ENEMY');
  check('上场后可发动效果出现', brief.activatable.length === 1 && brief.activatable[0].effect === 'study', brief.activatable);
  check('可发动效果带来源卡 id', brief.activatable[0].card === note.id, brief.activatable[0]);
  const text = renderBrief(brief);
  check('简报含可发动行', text.includes('可发动:') && text.includes('#study'), text);
}

// 需求: 玩家操作要记录并告知 AI; 已有效果要一并告知
{
  const state = setup();
  const spirit = handCard(state, 'ENEMY', '战意');
  playCard(state, spirit.id);
  activate(state, spirit.id, 'battle_spirit');

  const ops = ['T1 玩家 上场「愿之芽」', 'T1 玩家 「愿之芽」攻击 敌方玩家'];
  const brief = buildBrief(state, 'ENEMY', ops);
  check('操作记录进入简报', brief.player_ops.length === 2 && brief.player_ops[0].includes('上场'), brief.player_ops);
  check('持续状态进入简报', brief.statuses.length === 1 && brief.statuses[0].name === '战意', brief.statuses);
  check('持续状态带层数与剩余回合', brief.statuses[0].stacks === 1 && brief.statuses[0].remaining !== null, brief.statuses[0]);
  check('持续状态带施加者', brief.statuses[0].source === '战意', brief.statuses[0]);

  const text = renderBrief(brief);
  check('简报渲染已有效果', text.includes('已有效果:') && text.includes('战意'), text);
  check('简报渲染最近操作', text.includes('最近操作:') && text.includes('上场「愿之芽」'), text);
  check('已有效果写出施加者', text.includes('战意 (2T) ←「战意」'), text);
  // 事件流水是 DEBUG, 不该塞给 AI
  check('最近战况不含 DEBUG 事件流水', brief.recent.every(line => !line.includes('时点 ')), brief.recent);
}

// 需求: 面板/AI 看到一个 +200 时要能追溯回来源卡
{
  const state = setup();
  const brief = buildBrief(state, 'ENEMY');
  check('简报里卡带加成来源', brief.ai_field[0].bonuses.length === 1, brief.ai_field[0].bonuses);
  check('来源写明了是哪张卡', brief.ai_field[0].bonuses[0].includes('「愿之芽」'), brief.ai_field[0].bonuses);
  const text = renderBrief(brief);
  check('渲染时把来源放进花括号', text.includes('{ATK +200 ← 「愿之芽」}'), text);
  check('花括号被转义, 不会被当成宏', !text.includes('{{'), text);
}

{
  const state = setup();
  const many = Array.from({ length: 20 }, (_, index) => `T1 操作${index}`);
  const brief = buildBrief(state, 'ENEMY', many);
  check('操作记录有条数上限', brief.player_ops.length === 10, brief.player_ops.length);
  check('保留的是最新的几条', brief.player_ops.at(-1) === 'T1 操作19', brief.player_ops.at(-1));
}

// ---------------------------------------------------------------------------
section('1. 决策: 从回复中提取');

{
  const text = '敌方缓缓抬手。\n<battle_action>{"回合":3,"操作":[{"do":"end"}]}</battle_action>';
  const decision = extractDecision(text);
  check('解析成功', decision.ok, decision.error);
  check('回合数被读出', decision.turn === 3, decision.turn);
  check('操作数为 1', decision.ops?.length === 1, decision.ops);
  check('cleaned 去掉决策块', decision.cleaned === '敌方缓缓抬手。', decision.cleaned);
  check('raw 保留原文', decision.raw.startsWith('<battle_action>'), decision.raw);
}

{
  const decision = extractDecision('```json\n<battle_action>[{"do":"end"}]</battle_action>\n```');
  check('裸数组 + 代码围栏也能解析', decision.ok && decision.ops?.length === 1, decision.error);
  check('裸数组没有回合号', decision.turn === null, decision.turn);
}

{
  const decision = extractDecision(
    '<battle_action>{"操作":[{"do":"end"}]}</battle_action>\n<battle_action>{"回合":2,"操作":[{"do":"end"},{"do":"end"}]}</battle_action>',
  );
  check('多个决策块取最后一个', decision.turn === 2 && decision.ops?.length === 2, decision);
  check('cleaned 去掉所有决策块', decision.cleaned === '', JSON.stringify(decision.cleaned));
}

{
  const decision = extractDecision('说明文字 {"回合":1,"操作":[{"do":"end"}]} 结尾');
  check('没有标签时报错', !decision.ok && decision.error === '没有找到决策块', decision.error);
}

{
  const decision = extractDecision('<battle_action>{"回合":1,"操作":[</battle_action>');
  check('坏 JSON 报错', !decision.ok && decision.error.includes('解析失败'), decision.error);
}

{
  const decision = extractDecision('<battle_action>{"回合":1}</battle_action>');
  check('缺少操作数组报错', !decision.ok && decision.error.includes('缺少 操作'), decision.error);
}

// ---------------------------------------------------------------------------
section('2. 决策: 应用到引擎');

{
  const state = setup();
  const note = handCard(state, 'ENEMY', '研究笔记');
  const { result } = applyDecisionText(
    state,
    `<battle_action>{"回合":1,"操作":[{"do":"play","card":"${note.id}"}]}</battle_action>`,
    'ENEMY',
  );
  check('上场操作成功', result.ok && result.applied.length === 1, result);
  check('卡已到场上', state.cards[note.id].zone === 'FIELD');
  // 一个回合 = 双方各行动一次: ENEMY 收手只是换边, 回合数不变
  check(
    '执行完自动换边 (回合数不变, 交给对手)',
    result.ended && state.turn === 1 && state.active === 'PLAYER' && state.active_index === 1,
    { turn: state.turn, active: state.active, index: state.active_index },
  );
  check('日志被带出', result.log.length > 0, result.log);

  // 双方都收手后进入回合结算, 回合数 +1 回到先手方
  const second = applyDecisionText(state, '<battle_action>{"回合":1,"操作":[]}</battle_action>', 'PLAYER');
  check('双方收手后回合 +1', second.result.ok && state.turn === 2, { turn: state.turn, active: state.active });
  check('新回合回到先手方', state.active === 'ENEMY' && state.active_index === 0, state.active);
}

{
  const state = setup();
  const attacker = fieldCard(state, 'ENEMY', '愿之芽')!;
  const target = fieldCard(state, 'PLAYER', '愿之芽')!;
  const { result } = applyDecisionText(
    state,
    `<battle_action>{"回合":1,"操作":[{"do":"attack","card":"${attacker.id}","target":"${target.id}"}]}</battle_action>`,
    'ENEMY',
  );
  check('攻击操作成功', result.ok && result.applied[0].startsWith('攻击'), result);
  // 愿之芽 护盾 100: 500 伤害先扣光护盾, 剩下的 400 才扣生命 (800 → 400)
  check('伤害先扣护盾再扣生命 (护盾 100 挡住后 800 - 400 = 400)', state.cards[target.id].current.hp === 400, state.cards[target.id].current);
  check('护盾被打空', state.cards[target.id].current.shield === 0, state.cards[target.id].current);
}

{
  const state = setup();
  const attacker = fieldCard(state, 'ENEMY', '愿之芽')!;
  const target = fieldCard(state, 'PLAYER', '愿之芽')!;
  const { result } = applyDecisionText(
    state,
    `<battle_action>{"回合":1,"操作":[{"do":"attack","card":"${attacker.id}","target":"${target.id}"},{"do":"attack","card":"${attacker.id}","target":"PLAYER"}]}</battle_action>`,
    'ENEMY',
  );
  check('同一张卡第二次攻击被跳过', result.applied.length === 1 && result.ignored.length === 1, result);
  check('跳过原因说明已攻击', result.ignored[0].includes('已攻击'), result.ignored);
  check('玩家生命未因第二次攻击减少', state.players.PLAYER.hp === 8000);
}

{
  const state = setup();
  const note = handCard(state, 'ENEMY', '研究笔记');
  const { result } = applyDecisionText(
    state,
    `<battle_action>{"回合":1,"操作":[{"do":"play","card":"${note.id}"},{"do":"activate","card":"${note.id}","effect":"study"},{"do":"end"}]}</battle_action>`,
    'ENEMY',
  );
  check('上场 + 发动 + 显式结束', result.ok && result.applied.length === 3, result);
  check('显式 end 仍然正常结束行动', result.ended && state.active === 'PLAYER', { ended: result.ended, active: state.active });
  check('研究笔记效果已计入使用次数', Object.values(state.counters).some(value => value >= 1), state.counters);
}

{
  const state = setup();
  const { result } = applyDecisionText(
    state,
    `<battle_action>{"回合":1,"操作":[{"do":"activate","card":"c999","effect":"study"},{"do":"play","card":"c999"}]}</battle_action>`,
    'ENEMY',
  );
  check('未知卡 id 全部被跳过', result.ok && result.applied.length === 0 && result.ignored.length === 2, result);
  check('跳过原因说明卡牌 id', result.ignored[0].includes('不存在的卡牌 id'), result.ignored);
}

{
  const state = setup();
  const { result } = applyDecisionText(state, '<battle_action>{"回合":1,"操作":[]}</battle_action>', 'ENEMY');
  check('空操作数组 = 过回合', result.ok && result.ended && state.active === 'PLAYER', result);
}

// ---------------------------------------------------------------------------
section('3. 决策: 整块拒绝');

{
  const state = setup();
  state.active = 'PLAYER';
  const { result } = applyDecisionText(state, '<battle_action>{"回合":1,"操作":[]}</battle_action>', 'ENEMY');
  check('不是 AI 的回合时拒绝', !result.ok && result.error.includes('不是 ENEMY 的回合'), result);
  check('拒绝后回合未推进', state.turn === 1 && state.active === 'PLAYER');
}

{
  const state = setup();
  state.finished = true;
  const { result } = applyDecisionText(state, '<battle_action>{"回合":1,"操作":[]}</battle_action>', 'ENEMY');
  check('战斗已结束时拒绝', !result.ok && result.error.includes('已经结束'), result);
}

{
  const state = setup();
  const { result } = applyDecisionText(state, '<battle_action>{"回合":9,"操作":[]}</battle_action>', 'ENEMY');
  check('回合数不匹配时拒绝', !result.ok && result.error.includes('回合数不匹配'), result);
  check('拒绝后回合未推进', state.turn === 1);
}

{
  const state = setup();
  const ops = Array.from({ length: MAX_DECISION_OPS + 1 }, () => ({ do: 'end' }));
  const { result } = applyDecisionText(
    state,
    `<battle_action>${JSON.stringify({ 回合: 1, 操作: ops })}</battle_action>`,
    'ENEMY',
  );
  check('超过操作数上限时拒绝', !result.ok && result.error.includes('上限'), result);
}

{
  const state = setup();
  const { result } = applyDecisionText(state, '没有决策块', 'ENEMY');
  check('没有决策块时拒绝', !result.ok && result.error === '没有找到决策块', result);
}

{
  // 直接调用 applyDecision 验证空决策被拒绝
  const state = setup();
  const decision = extractDecision('<battle_action>{"回合":1}</battle_action>');
  const result = applyDecision(state, decision, 'ENEMY');
  check('结构不合法时拒绝', !result.ok && result.error.includes('缺少 操作'), result);
}

// ---------------------------------------------------------------------------
section('4. 协议提示词');

{
  check('空简报返回空串 (不污染上下文)', buildPromptText('') === '' && buildPromptText('   ') === '');
  const prompt = buildPromptText('回合 1 · 行动方 你(ENEMY)');
  check('含决策块标签', prompt.includes('<battle_action>') && prompt.includes('</battle_action>'));
  check('含操作语法', prompt.includes('"do":"play"') && prompt.includes('"do":"activate"'));
  check('含能量说明', prompt.includes('能量') && prompt.includes('费'));
  check(
    '含询问回答写法 (含收手时写在最外层)',
    prompt.includes('"do":"answer"') && prompt.includes('"do":"discard"') && prompt.includes('最外层'),
  );
  check('含回合校验规则', prompt.includes('「回合」必须等于简报里的回合数'));
  check('含简报正文', prompt.includes('回合 1 · 行动方 你(ENEMY)'));
  check('固定协议不含宏花括号', !protocolText().includes('{{'), protocolText());
}

{
  const prompt = buildPromptText('卡名里有 {{ 这种字符');
  check('简报里的花括号被转义, 避免被当宏', !prompt.includes('{{'), prompt);
}

{
  const note = bothSidesNote();
  check('双方操控提示词含不输出决策的要求', note.includes('不要输出任何 battle_action 决策块'), note);
  check('双方操控提示词不含宏花括号', !note.includes('{{'), note);
}

// ---------------------------------------------------------------------------
section('5. 变量结构: 缺字段时全部走默认值');

{
  const store = BattleAIStoreSchema.parse({});
  check('版本默认为当前版本', store.版本 === BATTLE_STORE_VERSION && BATTLE_STORE_VERSION === 3, store.版本);
  check('进行中默认 false', store.进行中 === false);
  check('待决策默认 false', store.待决策 === false);
  check('用户操控双方默认 false', store.用户操控双方 === false);
  check('本回合操作默认为空数组', Array.isArray(store.本回合操作) && store.本回合操作.length === 0);
  check('简报默认空串', store.简报 === '');
  check('局面默认 null', store.局面 === null);
  check('配置默认 null', store.配置 === null);
  check('变量路径为 战斗.AI', BATTLE_AI_PATH === '战斗.AI', BATTLE_AI_PATH);
}

{
  const setup = BattleSetupSchema.parse({});
  check('卡组默认为空数组', setup.我方卡组.length === 0 && setup.敌方卡组.length === 0);
  check('生命默认 8000', setup.我方生命 === 8000 && setup.敌方生命 === 8000);
  check('先手默认 PLAYER', setup.先手 === 'PLAYER');
  check('牌库轮换默认 GRAVEYARD', setup.牌库轮换 === 'GRAVEYARD');
  check('每回合抽牌默认 1', setup.每回合抽牌 === 1, setup.每回合抽牌);
  check('洗牌上限默认 0 (不限)', setup.洗牌上限 === 0, setup.洗牌上限);
  check('洗牌惩罚默认 1', setup.洗牌惩罚 === 1, setup.洗牌惩罚);
  check('守卫规则默认开', setup.守卫规则 === true, setup.守卫规则);
  check('溢出传伤默认 0.5', setup.溢出传伤 === 0.5, setup.溢出传伤);
  check('回合上限默认 30', setup.回合上限 === 30, setup.回合上限);
  check('字符串数字会被转成数字', BattleSetupSchema.parse({ 种子: '42' }).种子 === 42);
}

// ---------------------------------------------------------------------------
section('6. 世界书条目: 条件判定 + 变量读取 (手动安装用)');

{
  const content = battleEntryContent();
  check('以 {{if 开头', content.startsWith('{{if {{get_chat_variable::战斗.AI.待决策}}}}'), content.slice(0, 60));
  check('以 {{/if}} 结尾', content.trimEnd().endsWith('{{/if}}'));
  check('用 format_chat_variable 读简报', content.includes('{{format_chat_variable::战斗.AI.简报}}'));
  check('包含协议正文', content.includes(protocolText()));
  check('包含双方操控提示词', content.includes(bothSidesNote()));
  check('三个条件块: 待决策 / 双方操控 / 进行中', content.includes('战斗.AI.用户操控双方') && content.includes('战斗.AI.进行中'));
  check(
    'if / endif 成对',
    (content.match(/\{\{if /g) ?? []).length === 3 && (content.match(/\{\{\/if\}\}/g) ?? []).length === 3,
  );
  check('条目名与世界书名非空', BATTLE_ENTRY_NAME.length > 0 && BATTLE_WORLDBOOK_NAME.length > 0);
  check('协议版本为正整数', Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION > 0);
}

{
  const entry = battleTavernEntry(0);
  check('原生格式用 comment 存名字', entry.comment === BATTLE_ENTRY_NAME);
  check('原生格式: 蓝灯 (constant)', entry.constant === true && entry.selective === false);
  check('原生格式: at_depth / system / depth 0', entry.position === 4 && entry.role === 0 && entry.depth === 0);
  check('原生格式: 排序 100', entry.order === 100);
  check('原生格式: 概率 100', entry.useProbability === true && entry.probability === 100);
  check('原生格式: 关闭递归', entry.excludeRecursion === true && entry.preventRecursion === true);
  check('原生格式: 无 sticky/cooldown/delay', entry.sticky === null && entry.cooldown === null && entry.delay === null);
  check('原生格式: 内容与助手格式一致', entry.content === battleEntryContent());
}

{
  const file = battleWorldbookFile();
  check('文件结构为 { entries: { 0: ... } }', Boolean(file.entries['0']));
  check('文件条目与原生格式一致', file.entries['0'].content === battleEntryContent());
  check('文件可 JSON 序列化', JSON.stringify(file).includes(BATTLE_ENTRY_NAME));
}

// ---------------------------------------------------------------------------
section('7. 日志整理 (操作 / 引擎 / AI 决策)');
{
  const items = collectBattleLogs({
    ops: ['T2 玩家 上场「愿之芽」', 'T3 AI 「愿之芽」攻击 玩家'],
    log: [
      { turn: 2, kind: 'COMBAT', level: 'INFO', message: '愿之芽 受到 500 点伤害' },
      { turn: 1, kind: 'SYSTEM', level: 'INFO', message: '战斗开始' },
    ],
    ai: '✔ 上场「愿之芽」\n✖ 攻击失败',
    aiTurn: 3,
  });
  check('共 5 条', items.length === 5, items.length);
  check('按回合升序排列', items.map(item => item.turn).join(',') === '1,2,2,3,3', items.map(item => item.turn));
  check('操作记录解析出回合与正文', items.find(item => item.source === 'OP')?.text === '玩家 上场「愿之芽」');
  check('引擎日志带中文类别名', items.some(item => item.label === '战斗' && item.text.includes('500')));
  check('AI 决策作为一条日志', items.some(item => item.source === 'AI' && item.text.includes('✖')));
  const turn2 = items.filter(item => item.turn === 2);
  check(
    '同一回合内操作排在引擎日志前',
    turn2.findIndex(item => item.source === 'OP') < turn2.findIndex(item => item.source === 'ENGINE'),
    turn2.map(item => item.source),
  );
  check(
    '无回合前缀的行也能解析',
    parseOpLine('没有回合前缀').turn === 0 && parseOpLine('没有回合前缀').text === '没有回合前缀',
  );
  check('空 AI 结果不产生条目', collectBattleLogs({ ai: '   ' }).length === 0);
  const multi = collectBattleLogs({ decisions: ['T1 ✔ 上场', 'T2 ✔ 攻击'], ai: '忽略我' });
  check('多条决策优先于单条结果', multi.length === 2 && multi.every(item => item.source === 'AI'), multi.length);
}

{
  const items = collectBattleLogs({
    ops: ['T1 玩家 上场「愿之芽」'],
    log: [
      { turn: 1, kind: 'COMBAT', level: 'INFO', message: '愿之芽 造成伤害' },
      { turn: 1, kind: 'EFFECT', level: 'DEBUG', message: '愿之芽 发动效果' },
      { turn: 1, kind: 'SYSTEM', level: 'WARN', message: '无效的攻击目标' },
    ],
    ai: '✔ 攻击',
    aiTurn: 1,
  });
  check('全部过滤返回全部', filterBattleLogs(items, 'ALL').length === 5);
  check('按来源过滤操作', filterBattleLogs(items, 'OP').length === 1);
  check('按来源过滤 AI', filterBattleLogs(items, 'AI').length === 1);
  check('按类别过滤战斗', filterBattleLogs(items, 'COMBAT').length === 1);
  check('按类别过滤效果', filterBattleLogs(items, 'EFFECT')[0]?.text.includes('发动效果') === true);
  check('按等级过滤警告', filterBattleLogs(items, 'WARN').length === 1, filterBattleLogs(items, 'WARN'));
  check('按等级过滤调试', filterBattleLogs(items, 'DEBUG').length === 1);
  check('等级与类别不冲突 (EFFECT 与 DEBUG 各归各的)', filterBattleLogs(items, 'EFFECT').length === 1);
  const counts = logCounts(items);
  check('角标计数正确', counts.ALL === 5 && counts.OP === 1 && counts.AI === 1 && counts.COMBAT === 1, counts);
  check('等级角标计数正确', counts.WARN === 1 && counts.DEBUG === 1 && counts.INFO === 1, counts);
  check(
    '过滤按钮含全部/来源/等级',
    LOG_FILTERS[0].key === 'ALL' &&
      LOG_FILTERS.some(option => option.key === 'WARN') &&
      LOG_FILTERS.some(option => option.key === 'INFO'),
    LOG_FILTERS.map(option => option.key),
  );
  check('七个引擎类别都有中文名', Object.keys(LOG_KIND_LABELS).length === 7);
  check('四个等级都有中文名', Object.keys(LOG_LEVEL_LABELS).length === 4, LOG_LEVEL_LABELS);
  check('isLogLevel 能区分等级与类别', isLogLevel('WARN') && !isLogLevel('COMBAT'));
}

{
  // 多选 + OR/AND + 搜索词
  const items = collectBattleLogs({
    ops: ['T1 玩家 上场「愿之芽」'],
    log: [
      { turn: 1, kind: 'COMBAT', level: 'INFO', message: '愿之芽 造成伤害' },
      { turn: 1, kind: 'EFFECT', level: 'DEBUG', message: '愿之芽 发动效果' },
      { turn: 1, kind: 'ZONE', level: 'INFO', message: '愿之芽 进入场上' },
      { turn: 1, kind: 'SYSTEM', level: 'WARN', message: '无效的攻击目标' },
      { turn: 1, kind: 'EVENT', level: 'WARN', message: '卡牌库中找不到「不存在」', engine_only: true },
    ],
    ai: '✔ 攻击',
    aiTurn: 1,
  });
  check('共 7 条 (1 操作 + 5 引擎 + 1 决策)', items.length === 7, items.length);
  check(
    '默认条件 = 信息及以上',
    DEFAULT_LOG_FILTER_KEYS.join(',') === 'INFO,WARN,ERROR' && DEFAULT_LOG_QUERY.mode === 'OR',
    DEFAULT_LOG_FILTER_KEYS,
  );
  check(
    '默认只看 4 条 (调试与操作/AI 都不显示)',
    filterLogs(items, DEFAULT_LOG_QUERY).length === 4,
    filterLogs(items, DEFAULT_LOG_QUERY).map(item => item.text),
  );
  check('切到调试能看到调试日志 (引擎全都记着)', filterLogs(items, { keys: ['DEBUG'], mode: 'OR', search: '' }).length === 1);
  check('一个标签都不选 = 不按标签筛 (7 条)', filterLogs(items, { keys: [], mode: 'OR', search: '' }).length === 7);
  check('OR: 警告或错误', filterLogs(items, { keys: ['WARN', 'ERROR'], mode: 'OR', search: '' }).length === 2);
  check('OR: 警告或调试 = 3 条', filterLogs(items, { keys: ['WARN', 'DEBUG'], mode: 'OR', search: '' }).length === 3);
  check('AND: 警告 且 系统 = 1 条', filterLogs(items, { keys: ['WARN', 'SYSTEM'], mode: 'AND', search: '' }).length === 1);
  check('AND: 警告 且 战斗 = 0 条 (维度无交集)', filterLogs(items, { keys: ['WARN', 'COMBAT'], mode: 'AND', search: '' }).length === 0);
  check('AND: 等级 + 类别交叉', filterLogs(items, { keys: ['INFO', 'COMBAT'], mode: 'AND', search: '' }).length === 1);
  check('搜索正文', filterLogs(items, { keys: [], mode: 'OR', search: '发动' }).length === 1);
  check('多个搜索词需全部命中', filterLogs(items, { keys: [], mode: 'OR', search: '愿之芽 进入' }).length === 1);
  check('搜索词命中不了就为空', filterLogs(items, { keys: [], mode: 'OR', search: 'zzz' }).length === 0);
  check(
    '搜索也能命中类别名',
    filterLogs(items, { keys: [], mode: 'OR', search: items[4].label }).length >= 1,
    items[4].label,
  );
  check('搜索与标签叠加 (搜索始终 AND)', filterLogs(items, { keys: ['DEBUG'], mode: 'OR', search: '进入' }).length === 0);
  check('搜索与标签叠加命中', filterLogs(items, { keys: ['ZONE'], mode: 'OR', search: '进入' }).length === 1);
  const op = items.find(item => item.source === 'OP');
  const combat = items.find(item => item.kind === 'COMBAT');
  check('matchLogKey: 按来源', op !== undefined && matchLogKey(op, 'OP') && !matchLogKey(op, 'AI'));
  check(
    'matchLogKey: 按等级 / 按类别',
    combat !== undefined && matchLogKey(combat, 'INFO') && matchLogKey(combat, 'COMBAT') && !matchLogKey(combat, 'WARN'),
  );
  check('matchLogKey: 操作记录没有等级, 不会被等级标签选中', op !== undefined && !matchLogKey(op, 'INFO'));

  check(
    '筛选标签分三组 (来源 2 / 等级 4 / 类别 7)',
    LOG_FILTER_GROUPS.map(group => group.options.length).join(',') === '2,4,7',
    LOG_FILTER_GROUPS.map(group => group.title),
  );
  check(
    '等级组带「默认只看信息及以上」的提示',
    LOG_FILTER_GROUPS.some(group => group.hint?.includes('信息及以上')),
  );
  check('拍平后仍以「全部」打头 (14 项)', LOG_FILTERS[0].key === 'ALL' && LOG_FILTERS.length === 14, LOG_FILTERS.length);
}

{
  // 引擎内部问题打「内部」标记
  const items = collectBattleLogs({
    log: [
      { turn: 1, kind: 'SYSTEM', level: 'WARN', message: '无效的攻击目标' },
      { turn: 1, kind: 'EVENT', level: 'WARN', message: '卡牌库中找不到「不存在」', engine_only: true },
      { turn: 1, kind: 'EVENT', level: 'ERROR', message: '事件队列异常', engine_only: true },
    ],
  });
  check('内部问题带「内部」标记', items.filter(item => item.internal).length === 2, items);
  check('操作相关的警告不带标记', items.find(item => item.text.includes('无效'))?.internal === false);
  check('引擎日志仍然都列在面板里', items.length === 3);
}

{
  // 引擎内部问题 (卡牌库缺卡) 不进简报; 操作相关的警告要进
  const state = setup();
  const attacker = fieldCard(state, 'ENEMY', '愿之芽');
  if (!attacker) {
    throw new Error('敌方场上没有愿之芽');
  }
  check('无效目标打不中', attack(state, attacker.id, 'not-a-card') === false);
  const brief = buildBrief(state, 'ENEMY');
  check(
    '操作相关的警告会进简报',
    brief.recent.some(line => line.includes('无效的攻击目标')),
    brief.recent,
  );

  const broken = createBattle({
    card_provider: provider,
    player_deck: ['1', '不存在的卡'],
    enemy_deck: ['1'],
    seed: 3,
    opening_hand: 0,
  });
  startBattle(broken);
  check(
    '缺卡记为 WARN 且带引擎内部标记',
    broken.log.some(entry => entry.level === 'WARN' && entry.message.includes('找不到') && entry.engine_only === true),
    broken.log.filter(entry => entry.level === 'WARN').map(entry => entry.message),
  );
  check(
    '引擎内部问题不进简报',
    buildBrief(broken, 'ENEMY').recent.every(line => !line.includes('找不到')),
    buildBrief(broken, 'ENEMY').recent,
  );
  check('简报里也不会有调试流水', buildBrief(state, 'ENEMY').recent.every(line => !line.includes('时点 ')));
}

// ---------------------------------------------------------------------------
section('8. 卡牌详情整理');

{
  const state = setup();
  const card = fieldCard(state, 'ENEMY', '愿之芽');
  if (!card) {
    throw new Error('敌方场上没有愿之芽');
  }
  const info = cardInfoRows(card);
  check('基础资料 8 行', info.length === 8, info.length);
  check('含稀有度与星级', info.some(row => row.label === '稀有度') && info.some(row => row.label === '星级'));
  check('空字段显示为破折号', cardInfoRows({ ...card, series: '' }).some(row => row.label === '系列' && row.value === '—'));

  const stats = cardStatRows(card);
  check('数值 5 行 (攻/盾/盾上限/血/上限)', stats.length === 5, stats.map(row => row.label));
  check('变化量等于当前值减基础值', stats.every(row => row.delta === row.value - row.base), stats);
  check('常驻修正被计入当前值', stats[0].value === 500 && stats[0].delta === 200, stats[0]);
  check(
    '每一个数值行都带数值键 (面板靠它定位到对应的来源块)',
    stats.map(row => row.stat).join(',') === 'atk,shield,shield_max,hp,hp_max',
    stats.map(row => row.stat),
  );

  const position = cardPositionRows(card);
  check('位置行含场上位置', position.some(row => row.label === '场上位置'), position);
  check('位置行含控制者且为敌方', position.some(row => row.label === '控制者' && row.value === '敌方'), position);
  check('位置行含已攻击标记', position.some(row => row.label === '本回合已攻击' && row.value === '否'));

  const effects = cardEffectRows(state, card);
  check('效果行能列出机读定义', effects.length >= 1 && effects[0].detail.includes('{'), effects.length);
  check('无时点的效果显示为常驻', effects[0].timing === '常驻', effects[0].timing);
  check('没写 limit 的效果不显示用量', effects[0].limit === '', effects[0]);
  check(
    '写了 limit 的效果显示用量 (未用时也要写出来)',
    cardEffectRows(state, handCard(state, 'ENEMY', '研究笔记'))[0].limit === '本回合 0/1 次',
    cardEffectRows(state, handCard(state, 'ENEMY', '研究笔记'))[0],
  );
  check('时点表包含主动发动', TIMING_LABELS.MANUAL === '主动发动');
  check('区域表包含牌库与场上', ZONE_LABELS.DECK === '牌库' && ZONE_LABELS.FIELD === '场上');

  const statuses = cardStatusRows(state, card);
  check('没有状态时为空数组', Array.isArray(statuses) && statuses.length === 0);

  check('时点表含换边与行动开始', TIMING_LABELS.SIDE_CHANGE === '换边' && TIMING_LABELS.SIDE_START === '行动开始');

  // 加成来源: 常驻 +200 要能指回「愿之芽」
  const traces = cardTraceRows(state, card);
  check('溯源列出 ATK 一行', traces.length === 1 && traces[0].label === 'ATK', traces);
  check('溯源行带数值键 (点数值就能对上)', traces[0].stat === 'atk', traces[0].stat);
  check('溯源带基础值与当前值', traces[0].base === 300 && traces[0].value === 500, traces[0]);
  check('每一段都能看到来源卡名', traces[0].lines[0].includes('「愿之芽」'), traces[0].lines);
  check('源文本形如 +200 ← …', traces[0].lines[0].startsWith('+200 ←'), traces[0].lines[0]);
  check('没有加成的卡不产生溯源行', cardTraceRows(state, handCard(state, 'PLAYER', '封印之匣')).length === 0);

  // 池值变动: 生命 / 护盾没有「基础值 + 修正」, 只能给流水
  check('没受过伤的卡没有池值流水', cardPoolRows(state, card).length === 0, cardPoolRows(state, card));
  const victim = fieldCard(state, 'PLAYER', '愿之芽');
  const striker = fieldCard(state, 'ENEMY', '愿之芽');
  if (!victim || !striker) {
    throw new Error('双方场上都该有愿之芽');
  }
  attack(state, striker.id, victim.id);
  const pools = cardPoolRows(state, victim);
  check('池值变动分成护盾与生命两块', pools.map(row => row.stat).join(',') === 'shield,hp', pools.map(row => row.stat));
  check('护盾块带当前值 / 上限 / 净变化', pools[0].value === 0 && pools[0].max === 100 && pools[0].net === -100, pools[0]);
  check('生命块带当前值 / 上限 / 净变化', pools[1].value === 400 && pools[1].max === 800 && pools[1].net === -400, pools[1]);
  check('护盾流水写明回合 / 变化量 / 来源', pools[0].lines[0] === 'T1 -100 ← 「愿之芽」', pools[0].lines);
  check('生命流水同样写全', pools[1].lines[0] === 'T1 -400 ← 「愿之芽」', pools[1].lines);
  check('没被碰过的卡依然没有流水', cardPoolRows(state, fieldCard(state, 'ENEMY', '愿之芽')).length === 0);

  // 常驻光环: 上场时面板靠这个名单补一次浮字
  check('没写 id 的常驻效果不当光环名 (免得浮出「效果 1」)', cardAuraNames(state, card).length === 0, cardAuraNames(state, card));
}

{
  const 光环 = createCardProvider([
    {
      id: 'aura-card',
      name: '光环卡',
      atk: '100',
      shield: '0',
      hp: '500',
      machine_effect: {
        effects: [
          { id: '守护之光', modifiers: [{ stat: 'atk', value: 200 }] },
          { id: '突击', on: 'MANUAL', operations: [{ type: 'MODIFY', target: 'SELF', stat: 'atk', value: 50 }] },
        ],
      },
    },
  ]);
  check('光环测试卡机读区合法', Object.keys(光环.errors).length === 0, 光环.errors);
  const state = createBattle({
    card_provider: 光环.provider,
    player_deck: ['光环卡'],
    enemy_deck: [],
    seed: 5,
    opening_hand: 1,
  });
  startBattle(state);
  const aura_card = cardsInZone(state, 'PLAYER', 'HAND')[0];
  check('手牌里的卡不报光环 (光环只在场上生效)', cardAuraNames(state, aura_card).length === 0, cardAuraNames(state, aura_card));
  playCard(state, aura_card.id);
  check(
    '上场后报出写了 id 的常驻光环, 带 on 的不算',
    cardAuraNames(state, aura_card).join(',') === '守护之光',
    cardAuraNames(state, aura_card),
  );
}

// ---------------------------------------------------------------------------
section('9. 调试信息: 世界书条目会注入什么');

{
  const store = BattleAIStoreSchema.parse({
    进行中: true,
    待决策: true,
    简报: '回合 2 · 当前行动方 你(ENEMY)',
  });
  const segments = buildDebugSegments(store);
  check('三段各对应一条世界书条件', segments.length === 3, segments.map(item => item.title));
  check('条件写的是变量路径', segments[0].condition === `${BATTLE_AI_PATH}.待决策`, segments[0].condition);
  check('待决策时注入决策协议', segments[0].active && segments[0].text.includes('battle_action'));
  check('没开双方操控时不注入那一段', !segments[1].active && segments[1].text === '');
  check('进行中时注入带小标题的简报', segments[2].text.startsWith('【本回合简报】'), segments[2].text);

  const prompt = renderDebugPrompt(segments);
  check('完整文本含协议与简报', prompt.includes('battle_action') && prompt.includes('【本回合简报】'));
  check('未生效的段不占位置', !prompt.includes('双方操控'));

  const off = renderDebugPrompt(buildDebugSegments(BattleAIStoreSchema.parse({})));
  check('不开战时什么都不注入', off === '');
}

{
  const info = collectBattleDebug({
    store: BattleAIStoreSchema.parse({ 用户操控双方: true, 结果: '✔ 上场 c9' }),
    replies: [
      {
        message_id: 7,
        text: '他抬起手。<battle_action>{"操作":[]}</battle_action>',
        decision_raw: '<battle_action>{"操作":[]}</battle_action>',
        decision_ok: true,
        decision_error: '',
        ops: 0,
      },
    ],
    decisions: ['T1 (没有操作)'],
    ops: ['T1 玩家 上场「愿之芽」'],
    practice: true,
  });
  check('双方操控时只注入那一段', info.segments.filter(item => item.active).length === 1);
  check('结算结果取自变量', info.result === '✔ 上场 c9');
  check('回复原样带回', info.replies[0].message_id === 7 && info.replies[0].ops === 0);
  check('演习标记被保留', info.practice);
  check('操作记录原样带回', info.ops[0] === 'T1 玩家 上场「愿之芽」');
}

{
  const huge = BattleAIStoreSchema.parse({ 进行中: true, 简报: 'x'.repeat(DEBUG_JSON_LIMIT + 200) });
  const info = collectBattleDebug({ store: huge, replies: [], decisions: [], ops: [] });
  check('超长变量 JSON 会被截断展示', info.store_truncated && info.store_json.length === DEBUG_JSON_LIMIT);
  check('截断只影响展示', info.segments[2].text.includes('x'.repeat(100)));
}

// ---------------------------------------------------------------------------
section('10. 回放: 步骤能重演出同一场战斗');
// ---------------------------------------------------------------------------

{
  /** 与同步.ts 的做法一致: 一次操作 = 一串结构性 op + 是否结束行动 */
  function liveStep(state: BattleState, side: PlayerId, ops: unknown[], ended: boolean): void {
    executeOps(state, side, ops);
    if (ended && !state.finished) {
      endSide(state, side);
    }
  }

  let seq = 0;
  function step(params: {
    方: PlayerId;
    回合: number;
    操作: unknown[];
    说明: string;
    结束行动: boolean;
    来源?: 'PLAYER' | 'AI';
    楼层?: number | null;
    指纹?: string;
  }): ReplayStep {
    seq += 1;
    return {
      序号: seq,
      回合: params.回合,
      方: params.方,
      来源: params.来源 ?? 'PLAYER',
      楼层: params.楼层 ?? null,
      指纹: params.指纹 ?? '',
      说明: params.说明,
      操作: params.操作,
      结束行动: params.结束行动,
    };
  }

  const replayConfig = {
    card_provider: provider,
    player_deck: ['1', '10', '1', '1'],
    enemy_deck: ['1', '9', '13', '1', '1'],
    seed: 11,
    opening_hand: 2,
    first: 'ENEMY' as const,
  };

  // 先手打一遍: 每一步都记下来, 顺便把它真的执行掉
  // (开局发牌由 startBattle 完成, 重放时也会重来一次, 所以两边拿到的牌与 id 都一样)
  const live = createBattle(replayConfig);
  startBattle(live);

  const steps: ReplayStep[] = [];
  const enemy_card = cardsInZone(live, 'ENEMY', 'HAND')[0].id;
  steps.push(step({ 方: 'ENEMY', 回合: 1, 操作: [{ do: 'play', card: enemy_card, slot: null }], 说明: '上场「愿之芽」', 结束行动: false }));
  liveStep(live, 'ENEMY', [{ do: 'play', card: enemy_card, slot: null }], false);
  steps.push(step({ 方: 'ENEMY', 回合: 1, 操作: [{ do: 'end' }], 说明: '结束行动', 结束行动: true }));
  liveStep(live, 'ENEMY', [{ do: 'end' }], true);

  const player_card = cardsInZone(live, 'PLAYER', 'HAND')[0].id;
  steps.push(step({ 方: 'PLAYER', 回合: 1, 操作: [{ do: 'play', card: player_card, slot: null }], 说明: '上场「愿之芽」', 结束行动: false }));
  liveStep(live, 'PLAYER', [{ do: 'play', card: player_card, slot: null }], false);
  steps.push(step({ 方: 'PLAYER', 回合: 1, 操作: [{ do: 'end' }], 说明: '结束行动', 结束行动: true }));
  liveStep(live, 'PLAYER', [{ do: 'end' }], true);

  // 第四条是 AI 决策: 打一拳然后收手, 带楼层锚点与决策指纹
  const ai_ops = [
    { do: 'attack', card: enemy_card, target: player_card },
    { do: 'end' },
  ];
  const ai_raw = '<battle_action>{"回合":2,"操作":[{"do":"attack","card":"c1","target":"c2"},{"do":"end"}]}</battle_action>';
  steps.push(
    step({
      方: 'ENEMY',
      回合: 2,
      操作: ai_ops,
      说明: '攻击 c1 → c2',
      结束行动: true,
      来源: 'AI',
      楼层: 5,
      指纹: hashText(ai_raw),
    }),
  );
  liveStep(live, 'ENEMY', ai_ops, true);

  const replayed = replayBattle(replayConfig, { 步骤: steps, 起点: null });
  check('重放与实操的局面一致', fingerprintState(replayed) === fingerprintState(live), {
    重放: fingerprintState(replayed),
    实际: fingerprintState(live),
  });
  check('重放后的血量一致', replayed.players.PLAYER.hp === live.players.PLAYER.hp);
  check('重放后的随机数序号一致', replayed.counters.__rng === live.counters.__rng);
  check('重放不修改原步骤数组', steps.length === 5);
  check('重放到一半就是当时的局面', fingerprintState(replayBattle(replayConfig, { 步骤: steps, 截止: 3 })) !== fingerprintState(live));

  // ---- 楼层锚点 ----
  const anchor_index = steps.length - 1;
  check('findStepIndex 找到楼层', findStepIndex(steps, 5) === anchor_index);
  check('findStepIndex 找不到时返回 -1', findStepIndex(steps, 99) === -1);
  check('rewindCountFor: 保留该步之前的步数', rewindCountFor(steps, 5) === anchor_index);
  check('rewindCountFor: 没锚点不动战斗', rewindCountFor(steps, 3) === -1);
  check('指纹一致时不动', stepMatchesFingerprint(steps[anchor_index], hashText(ai_raw)));
  check('指纹不同时才回退', !stepMatchesFingerprint(steps[anchor_index], hashText(`${ai_raw} `)));
  check('空指纹永远不匹配', !stepMatchesFingerprint({ ...steps[anchor_index], 指纹: '' }, ''));

  const shifted_steps: ReplayStep[] = steps.map(item => ({ ...item }));
  check('删除楼层后锚点前移', shiftAnchorsAfterDelete(shifted_steps, 4) === 1 && shifted_steps[anchor_index].楼层 === 4);
  check('删除位置之前的锚点不动', shiftAnchorsAfterDelete(shifted_steps, 9) === 0);
  renumberSteps(shifted_steps, 10);
  check('renumberSteps 带偏移重排', shifted_steps[0].序号 === 11 && shifted_steps[anchor_index].序号 === 10 + steps.length);

  // ---- 体积与体检 ----
  const first_size = replaySize({ 步骤: steps, 起点: null, 已丢弃: 0 });
  check('体积合计 = 步骤 + 起点', first_size.合计 === first_size.步骤 && first_size.起点 === 0);
  check('平均每步 = 步骤 / 条数', first_size.平均每步 === Math.round(first_size.步骤 / steps.length));
  check('jsonBytes 对不可序列化的值返回 0', jsonBytes(() => 1) === 0);

  const report = inspectReplay(replayConfig, { 步骤: steps, 起点: null, 已丢弃: 0 }, live);
  check('体检: 步骤数与已丢弃', report.步骤数 === steps.length && report.已丢弃 === 0);
  check('体检: 重放一致', report.一致 && report.差异 === '' && report.错误 === '');
  check('体检: 有起点为 false', !report.有起点);
  check('体检: 有当前局面指纹', report.指纹 === fingerprintState(live));

  const broken = { ...live, players: { ...live.players, PLAYER: { ...live.players.PLAYER, hp: 1 } } } as BattleState;
  const broken_report = inspectReplay(replayConfig, { 步骤: steps, 起点: null, 已丢弃: 0 }, broken);
  check('体检: 局面被改过时报不一致', !broken_report.一致 && broken_report.差异.length > 0);
  check('体检: 没有战斗时无从比对', inspectReplay(replayConfig, { 步骤: steps, 起点: null, 已丢弃: 0 }, null).差异.length > 0);
}

// ---------------------------------------------------------------------------
section('11. 回放: 步骤过长时压进起点快照');
// ---------------------------------------------------------------------------

{
  const config = {
    card_provider: provider,
    player_deck: ['1', '10'],
    enemy_deck: ['1', '9'],
    seed: 3,
    opening_hand: 0,
    first: 'PLAYER' as const,
  };
  const total = REPLAY_STEP_LIMIT + 5;
  const many: ReplayStep[] = [];
  for (let index = 0; index < total; index += 1) {
    many.push({
      序号: index + 1,
      回合: Math.floor(index / 2) + 1,
      方: index % 2 === 0 ? 'PLAYER' : 'ENEMY',
      来源: 'PLAYER',
      楼层: null,
      指纹: '',
      说明: '结束行动',
      操作: [{ do: 'end' }],
      结束行动: true,
    });
  }

  const before = replayBattle(config, { 步骤: many, 起点: null });
  const compacted = compactReplay(config, { 步骤: many, 起点: null, 已丢弃: 0 });
  check('超过上限时压缩', compacted.步骤.length === REPLAY_KEEP_STEPS);
  check('压缩记录了丢弃数量', compacted.已丢弃 === total - REPLAY_KEEP_STEPS);
  check('压缩后带起点快照', compacted.起点 !== null && compacted.起点 !== undefined);
  check('压缩后序号带偏移重排', compacted.步骤[0].序号 === compacted.已丢弃 + 1);
  check('压缩后起点快照的日志被裁过', (compacted.起点 as BattleState).log.length <= 40);

  const after = replayBattle(config, { 步骤: compacted.步骤, 起点: compacted.起点 });
  check('压缩前后重放结果一致', fingerprintState(before) === fingerprintState(after), {
    压缩前: fingerprintState(before),
    压缩后: fingerprintState(after),
  });
  check('体检: 压缩后的回放也算一致', inspectReplay(config, compacted, before).一致);

  const unchanged = compactReplay(config, { 步骤: many.slice(0, 3), 起点: null, 已丢弃: 0 });
  check('没到上限时原样返回', unchanged.步骤.length === 3 && unchanged.起点 === null);
}

// ---------------------------------------------------------------------------
section('12. 调试: 变量占用量测');
// ---------------------------------------------------------------------------

{
  check('describeValue: 对象带条目数', describeValue({ a: 1, b: 2 }) === '对象(2)');
  check('describeValue: 数组带长度', describeValue([1, 2, 3]) === '数组(3)');
  check('describeValue: 字符串带字数', describeValue('卡牌') === '字符串(2 字)');
  check('describeValue: 数字', describeValue(7) === '数字');
  check('describeValue: null', describeValue(null) === 'null');

  const leaves = flattenLeaves({ 小: 'x', 大: { 里: 'y'.repeat(200) }, 空: {} });
  check('flattenLeaves 列出叶子路径', leaves.some(item => item.路径 === '大.里'));
  check('flattenLeaves 按大小排序', leaves[0].路径 === '大.里');
  check('flattenLeaves 空容器也算叶子', leaves.some(item => item.路径 === '空'));
  check('flattenLeaves 叶子带体积', leaves[0].字节数 === jsonBytes('y'.repeat(200)));
  check('flattenLeaves 数组下标进路径', flattenLeaves({ 卡: [{ name: 'a' }] }).some(item => item.路径 === '卡[0].name'));
  check('flattenLeaves 遵守条数上限', flattenLeaves({ a: 1, b: 2, c: 3 }, 2).length === 2);
  check(
    'flattenLeaves 达到层数上限就当叶子',
    flattenLeaves({ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }).some(item => item.类型.startsWith('对象')),
  );

  const report = buildScopeReport({
    key: 'chat',
    标题: '聊天变量',
    说明: '',
    value: { 战斗: { AI: { 简报: 'z'.repeat(50) } }, 面板外观: { 垫底色: '#0e1015' } },
  });
  check('buildScopeReport 可读', report.可读 && report.错误 === '');
  check('顶层按大小排序', report.顶层[0].路径 === '战斗');
  check('顶层带类型说明', report.顶层[0].类型.startsWith('对象'));
  check('合计等于整份 JSON 字节数', report.合计 === jsonBytes({ 战斗: { AI: { 简报: 'z'.repeat(50) } }, 面板外观: { 垫底色: '#0e1015' } }));
  check('叶子钻到最里面', report.叶子.some(item => item.路径 === '战斗.AI.简报'));
  check('JSON 预览可用', JSON.parse(report.json).战斗.AI.简报.length === 50);
  check('JSON 没被截断', !report.json_truncated);

  const empty = buildScopeReport({ key: 'character', 标题: '', 说明: '', value: null, 错误: '没进对话' });
  check('读不到时标记不可读', !empty.可读 && empty.错误 === '没进对话');
  check('读不到时不列叶子', empty.叶子.length === 0 && empty.顶层.length === 0);
  check('读不到时合计为 0', empty.合计 === 0);

  const huge = buildScopeReport({ key: 'script', 标题: '', 说明: '', value: { 大: 'x'.repeat(DEBUG_JSON_LIMIT + 100) } });
  check('超长变量 JSON 预览被截断', huge.json_truncated && huge.json.length === DEBUG_JSON_LIMIT);

  // ---- uuid 路径的可读名标签 (路径里只有 uuid, 认不出是哪张卡) ----
  const card_id = '11111111-2222-4333-8444-555555555555';
  const deck_id = '99999999-8888-4777-8666-555555555555';
  const names = buildNameLookup({
    character: { 卡牌库: { 卡牌: { [card_id]: { id: card_id, name: '苍岩幼龙' } } } },
    chat: { 卡组: { 卡组: { [deck_id]: { id: deck_id, 名称: '测试卡组' } } } },
  });
  check('认出卡牌库里的卡名', names.卡牌.get(card_id) === '苍岩幼龙');
  check('认出聊天变量里的卡组名', names.卡组.get(deck_id) === '测试卡组');
  check('名字为空就不算认出来', buildNameLookup({ character: { 卡牌库: { 卡牌: { x: { id: 'x', name: '  ' } } } } }).卡牌.size === 0);

  const card_leaves = flattenLeaves(
    { 卡牌库: { 卡牌: { [card_id]: { id: card_id, name: '苍岩幼龙', description: 'x'.repeat(50) } } } },
    DEBUG_LEAF_LIMIT,
    names,
  );
  const description = card_leaves.find(item => item.路径 === `卡牌库.卡牌.${card_id}.description`);
  check('卡牌叶子标上卡名', description?.标签?.文本 === '苍岩幼龙' && description?.标签?.种类 === '卡牌');

  const deck_leaves = flattenLeaves(
    { 卡组: { 卡组: { [deck_id]: { id: deck_id, 名称: '测试卡组', 卡牌: [card_id] } } } },
    DEBUG_LEAF_LIMIT,
    names,
  );
  const deck_name = deck_leaves.find(item => item.路径.endsWith('.名称'))?.标签;
  check('卡组字段标上卡组名', deck_name?.文本 === '测试卡组' && deck_name?.种类 === '卡组');
  check('卡组里存的卡牌 id 标的是卡名', deck_leaves.find(item => item.路径.endsWith('.卡牌[0]'))?.标签?.文本 === '苍岩幼龙');
  check('不给索引就一律没有标签', flattenLeaves({ a: { id: card_id } }).every(item => item.标签 === undefined));

  const named = buildScopeReport({
    key: 'character',
    标题: '',
    说明: '',
    value: { 卡牌库: { 卡牌: { [card_id]: { id: card_id, name: '苍岩幼龙', description: '很长的描述'.repeat(20) } } } },
    names,
  });
  check('面板报告里也带上了名字', named.叶子.some(item => item.标签?.文本 === '苍岩幼龙'));

  const deployed = buildNameLookup({
    chat: { 战斗: { 出战卡组: { 卡组id: deck_id, 名称: '出战卡组', 卡牌: [{ id: card_id, name: '苍岩幼龙' }] } } },
  });
  check('出战卡组快照里的卡组也认得出', deployed.卡组.get(deck_id) === '出战卡组');
  check('出战卡组快照里的卡牌也认得出', deployed.卡牌.get(card_id) === '苍岩幼龙');

  check('三个作用域都有元信息', SCOPE_META.length === 3);
  check('作用域键与酒馆变量类型一致', SCOPE_META.map(item => item.key).join(',') === 'character,chat,script');
}

// ---------------------------------------------------------------------------
section('N. 能量 / 手牌上限 / 询问 (战斗层接得住引擎的新机制)');
{
  const setup = BattleSetupSchema.parse({});
  check(
    '配置缺省: 手牌上限 8 / 能量开 / 起始 1 / 增长 1 / 上限 10 / 补满',
    setup.手牌上限 === 8 &&
      setup.能量开关 === true &&
      setup.起始能量 === 1 &&
      setup.能量增长 === 1 &&
      setup.能量上限 === 10 &&
      setup.能量补满 === true,
    setup,
  );
}
{
  // 能量不够时, AI 要能从简报里看出「为什么上不了场」
  const state = createBattle({
    card_provider: provider,
    player_deck: ['20', '20'],
    enemy_deck: ['1'],
    seed: 7,
    opening_hand: 0,
    energy: { start: 1, per_turn: 0, cap: 1 },
  });
  startBattle(state);
  drawCards(state, 'PLAYER', 99);
  const big = handCard(state, 'PLAYER', '燎原');

  const brief = buildBrief(state, 'PLAYER');
  check('简报里带上了双方能量', brief.ai_energy === 1 && brief.ai_energy_max === 1, {
    energy: brief.ai_energy,
    max: brief.ai_energy_max,
  });
  check('手牌价格进了简报文本', renderBrief(brief).includes('4费'), renderBrief(brief));
  check('不能上场的原因写明是能量不足', brief.ai_hand[0].play_block.includes('能量不足'), brief.ai_hand[0].play_block);

  const decision = extractDecision(`<battle_action>{"操作":[{"do":"play","card":"${big.id}"}]}</battle_action>`);
  const result = applyDecision(state, decision, 'PLAYER');
  check('决策里能量不足也会给出原因', result.ignored.some(line => line.includes('能量不足')), result.ignored);
}
{
  // 手牌超上限: 简报把询问摆出来, AI 用 answer 操作回答
  const state = createBattle({
    card_provider: provider,
    player_deck: ['1', '1', '1', '1'],
    enemy_deck: ['1'],
    seed: 7,
    opening_hand: 0,
    hand_limit: 2,
  });
  startBattle(state);
  drawCards(state, 'PLAYER', 3);

  const brief = buildBrief(state, 'PLAYER');
  check('简报里带上了待回答的询问', brief.asks.length === 1 && brief.asks[0].min === 1, brief.asks);
  check('询问里列出了可选的卡', brief.asks[0].options.length === 3, brief.asks[0].options);
  const text = renderBrief(brief);
  check('简报里写清了回答方式', text.includes('"do":"answer"'), text);
  check('简报里标出要选几张', text.includes('至少 1 张') && text.includes('最多 3 张'), text);

  const victim = cardsInZone(state, 'PLAYER', 'HAND')[1];
  const decision = extractDecision(
    `<battle_action>{"操作":[{"do":"answer","ask":"${brief.asks[0].id}","cards":["${victim.id}"]}]}</battle_action>`,
  );
  const result = applyDecision(state, decision, 'PLAYER');
  check('answer 操作回答成功', result.applied.some(line => line.includes('弃掉')), result);
  check('那张卡进了墓地', state.cards[victim.id].zone === 'GRAVEYARD', state.cards[victim.id].zone);
  check('询问消失', listAsks(state, 'PLAYER').length === 0);
}
{
  // 机读区标了 ask 的技能: AI 写 answers 才能发动
  const state = createBattle({
    card_provider: provider,
    player_deck: ['21'],
    enemy_deck: ['20'],
    seed: 7,
    opening_hand: 0,
    energy: { start: 10, per_turn: 0, cap: 10 },
  });
  startBattle(state);
  drawCards(state, 'PLAYER', 99);
  drawCards(state, 'ENEMY', 99);
  playCard(state, handCard(state, 'PLAYER', '守夜人').id);
  const guard = fieldCard(state, 'PLAYER', '守夜人')!;
  endSide(state, 'PLAYER');
  playCard(state, handCard(state, 'ENEMY', '燎原').id);
  const tank = fieldCard(state, 'ENEMY', '燎原')!;
  endSide(state, 'ENEMY');

  const askable = listAskable(state, 'PLAYER', ['AFTER_ATTACK']);
  check('能列出要确认的效果', askable.length === 1, askable);

  const without = extractDecision(
    `<battle_action>{"操作":[{"do":"attack","card":"${guard.id}","target":"${tank.id}"}]}</battle_action>`,
  );
  applyDecision(state, without, 'PLAYER');
  check('不写 answers 就不发动 (按卡上的 ask_default)', guard.current.atk === 400, guard.current.atk);

  endSide(state, 'PLAYER');
  endSide(state, 'ENEMY');
  const with_answers = extractDecision(
    `<battle_action>{"操作":[{"do":"attack","card":"${guard.id}","target":"${tank.id}","answers":["${askable[0].effect_id}"]}]}</battle_action>`,
  );
  const result = applyDecision(state, with_answers, 'PLAYER');
  check('写了 answers 就批准发动 (攻击力 +500)', guard.current.atk === 900, { atk: guard.current.atk, result });
}
{
  // 收手时触发的 ask 技能 (SIDE_END): 「结束行动」是自动补上的, 所以答案写在决策块最外层
  const build = (): BattleState => {
    const state = createBattle({
      card_provider: provider,
      player_deck: ['22'],
      enemy_deck: ['1'],
      seed: 7,
      opening_hand: 0,
      energy: { start: 10, per_turn: 0, cap: 10 },
    });
    startBattle(state);
    drawCards(state, 'PLAYER', 99);
    playCard(state, handCard(state, 'PLAYER', '值夜灯').id);
    return state;
  };

  const quiet = build();
  check(
    '收手前的可确认技能能被列出',
    listAskable(quiet, 'PLAYER', ['SIDE_END']).length === 1,
    listAskable(quiet, 'PLAYER', ['SIDE_END']),
  );
  applyDecision(quiet, extractDecision('<battle_action>{"操作":[]}</battle_action>'), 'PLAYER');
  check('最外层不写 answers 就不发动', fieldCard(quiet, 'PLAYER', '值夜灯')!.current.atk === 300);

  const lit = build();
  const result = applyDecision(
    lit,
    extractDecision('<battle_action>{"answers":["值夜"],"操作":[]}</battle_action>'),
    'PLAYER',
  );
  check('最外层写了 answers 就批准发动 (攻击力 +100)', fieldCard(lit, 'PLAYER', '值夜灯')!.current.atk === 400, {
    atk: fieldCard(lit, 'PLAYER', '值夜灯')!.current.atk,
    result,
  });
  check('收手照样完成', result.ok && result.ended && lit.active === 'ENEMY', { ok: result.ok, active: lit.active });
}

// ---------------------------------------------------------------------------
section('13. 播放: 一次操作 / 一次结算拆成帧');
// ---------------------------------------------------------------------------

/** 按同步层 (同步.ts 的 startPlaybackRecorder) 的做法录帧: 每写一条非 DEBUG 日志拷一份状态 */
function recordFrames(state: BattleState, run: (onFrame: (entry: LogEntry) => void) => void): BattleState[] {
  const frames: BattleState[] = [];
  run(entry => {
    // DEBUG 是事件流水 (每个时点一条), 拷它的快照太浪费, 而且它几乎不改变局面
    if (entry.level === 'DEBUG') {
      return;
    }
    frames.push(cloneBattleState(state));
  });
  return frames;
}

{
  const state = setup();
  const 起点 = cloneBattleState(state);
  const attacker = fieldCard(state, 'ENEMY', '愿之芽')!;
  const target = fieldCard(state, 'PLAYER', '愿之芽')!;
  const frames = recordFrames(state, onFrame =>
    applyDecision(
      state,
      extractDecision(
        `<battle_action>{"回合":1,"操作":[{"do":"attack","card":"${attacker.id}","target":"${target.id}"}]}</battle_action>`,
      ),
      'ENEMY',
      { onFrame },
    ),
  );

  check('攻击 + 自动收手都做完了', state.active === 'PLAYER' && state.turn === 1, { active: state.active });
  check('录到了帧', frames.length > 0, frames.length);

  const playback = buildBattlePlayback(frames, { 标题: 'AI 行动', 起始回合: 1, 起点 });
  check('能整理成播放内容', playback !== null);
  check('标题原样带过来', playback?.标题 === 'AI 行动', playback?.标题);
  check('整段都算「操作」帧', playback!.帧.every(frame => frame.种类 === '操作'));
  check('每一帧都有说明', playback!.帧.every(frame => frame.说明.length > 0), playback!.帧.map(frame => frame.说明));
  check('每一步都各占一帧', playback!.帧.length >= 2, playback!.帧.length);
  check('最后一帧带上了这次攻击的结果', playback!.帧.at(-1)!.状态.cards[target.id].current.hp === 400, {
    hp: playback!.帧.at(-1)!.状态.cards[target.id].current.hp,
  });
  check('伤害确实出现在中间某一帧', playback!.帧.some(frame => frame.状态.cards[target.id].current.hp === 400));
  check('第一帧已经和操作前不一样', fingerprintState(playback!.帧[0].状态) !== fingerprintState(起点));
}

{
  // 只说了一句话 (局面没变) 的日志不该单独占一帧, 而应该并到下一个真的变了的帧上
  const state = setup();
  const 起点 = cloneBattleState(state);
  const target = fieldCard(state, 'PLAYER', '愿之芽')!;
  const 快照: BattleState[] = [];
  state.log.push({ turn: 1, kind: 'SYSTEM', level: 'INFO', message: '先例行的说了一句话' });
  快照.push(cloneBattleState(state));
  target.current.hp -= 100;
  state.log.push({ turn: 1, kind: 'COMBAT', level: 'INFO', message: '挨了一下' });
  快照.push(cloneBattleState(state));

  const playback = buildBattlePlayback(快照, { 标题: 'AI 行动', 起始回合: 1, 起点 })!;
  check('只留下真正变化的帧', playback.帧.length === 1, playback.帧.length);
  check(
    '攒下的说明并到了那一帧',
    playback.帧[0].说明.includes('先例行的说了一句话') && playback.帧[0].说明.includes('挨了一下'),
    playback.帧[0].说明,
  );
}

{
  // 结算: 第一方收手只是换边 (同步层不交付), 第二方收手才推进回合 (交付)
  const state = setup();
  endSide(state, 'ENEMY');
  const 起点 = cloneBattleState(state);
  const 起始回合 = state.turn;
  const frames = recordFrames(state, onFrame => endSide(state, 'PLAYER', { onFrame }));

  check('第二方收手后回合推进', state.turn === 起始回合 + 1, state.turn);
  check('录到了帧', frames.length > 0, frames.length);

  const playback = buildBattlePlayback(frames, { 标题: '回合结算', 起始回合, 起点 });
  check('结算能整理成播放内容', playback !== null);
  check('有帧被标成结算', playback!.帧.every(frame => frame.种类 === '结算'), playback!.帧.map(frame => frame.种类));
  check('结算说明里带上了「结算」那句话', playback!.帧.some(frame => frame.说明.includes('结算')), playback!.帧.map(frame => frame.说明));
  check('最后一帧已经进入下一回合', playback!.帧.at(-1)!.状态.turn === 起始回合 + 1, playback!.帧.at(-1)!.状态.turn);
}

{
  // 局面一点没变 → 不播 (面板照旧直接看最终局面)
  const state = setup();
  const 起点 = cloneBattleState(state);
  check('一条快照都没有就不播', buildBattlePlayback([], { 标题: 'AI 行动', 起始回合: 1, 起点 }) === null);
  check(
    '局面没变就不播',
    buildBattlePlayback([cloneBattleState(state), cloneBattleState(state)], { 标题: 'AI 行动', 起始回合: 1, 起点 }) === null,
  );
}

{
  // 帧太多时尾部折成一帧 (局面仍是最终那份)
  const state = setup();
  const 起点 = cloneBattleState(state);
  const many: BattleState[] = [];
  for (let index = 1; index <= PLAYBACK_FRAME_LIMIT + 6; index += 1) {
    // 逼着指纹变化: 随机数计数器本来就是引擎每次随机都会动的东西
    state.counters.__rng = (state.counters.__rng ?? 0) + 1;
    state.log.push({ turn: state.turn, kind: 'SYSTEM', level: 'INFO', message: `第 ${index} 件事` });
    many.push(cloneBattleState(state));
  }

  const playback = buildBattlePlayback(many, { 标题: '回合结算', 起始回合: 1, 起点 })!;
  check('帧数被折到上限', playback.帧.length === PLAYBACK_FRAME_LIMIT, playback.帧.length);
  check('最后一帧是最终局面', fingerprintState(playback.帧.at(-1)!.状态) === fingerprintState(state));
  check(
    '折掉的说明并到了最后一帧',
    playback.帧.at(-1)!.说明.includes('第 24 件事') && playback.帧.at(-1)!.说明.includes('第 30 件事'),
    playback.帧.at(-1)!.说明,
  );
}

// ---------------------------------------------------------------------------
section('14. 战斗节奏: 播放间隔设置');
// ---------------------------------------------------------------------------

{
  check('默认两档都是 2 秒', DEFAULT_ACTION_INTERVAL === 2000 && DEFAULT_SETTLE_INTERVAL === 2000);
  check('默认节奏就是这两个值', defaultBattlePace().操作间隔 === 2000 && defaultBattlePace().结算间隔 === 2000);
  check('node 下读取返回默认值', loadBattlePace().操作间隔 === DEFAULT_ACTION_INTERVAL);

  const parsed = BattlePaceSchema.parse({ 操作间隔: '1500', 结算间隔: -20 });
  check('字符串数字能解析', parsed.操作间隔 === 1500, parsed);
  check('负数夹到 0 (0 = 不播)', parsed.结算间隔 === 0, parsed);
  check('超过上限被夹住', BattlePaceSchema.parse({ 操作间隔: 99999 }).操作间隔 === MAX_BATTLE_INTERVAL);
  check('非法数值回退默认', BattlePaceSchema.parse({ 操作间隔: 'abc' }).操作间隔 === DEFAULT_ACTION_INTERVAL);
  check('小数四舍五入成整数', BattlePaceSchema.parse({ 操作间隔: 1234.6 }).操作间隔 === 1235);
  check('缺字段时补默认值', BattlePaceSchema.parse({}).结算间隔 === DEFAULT_SETTLE_INTERVAL);

  const saved = saveBattlePace({ 结算间隔: 3000 });
  check('保存后立即生效', saved.结算间隔 === 3000 && loadBattlePace().结算间隔 === 3000);
  check('保存一档不影响另一档', loadBattlePace().操作间隔 === DEFAULT_ACTION_INTERVAL);

  let notified = 0;
  const off = onBattlePaceChanged(() => {
    notified += 1;
  });
  saveBattlePace({ 操作间隔: 4000 });
  check('订阅者收到通知', notified === 1, notified);
  off();
  saveBattlePace({ 操作间隔: 5000 });
  check('取消订阅后不再通知', notified === 1, notified);

  check('describeInterval: 0 说成不播', describeInterval(0) === '不播', describeInterval(0));
  check('describeInterval: 毫秒换算成秒', describeInterval(1500) === '1.5 秒', describeInterval(1500));
}

// ---------------------------------------------------------------------------
console.log(`\n通过 ${passed} 项, 失败 ${failed} 项`);
if (failed > 0) {
  process.exitCode = 1;
}
