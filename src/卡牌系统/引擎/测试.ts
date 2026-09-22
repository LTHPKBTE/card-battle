// 战斗引擎 - 测试脚本
//
// 运行: node src/卡牌系统/引擎/测试.ts
// (node 24 直接执行 .ts; 引擎内部导入统一带 .ts 扩展名, 因此无需构建)

import YAML from 'yaml';
import { 机读效果示例 } from '../卡牌/机读效果示例.ts';
import {
  activate,
  attack,
  attachBattleConfig,
  autoResolveAsk,
  battleConfig,
  canAttack,
  canMoveCardTo,
  canPayEnergy,
  canPlayCard,
  cardCost,
  cardCostFor,
  createBattle,
  drawCards,
  endSide,
  endTurn,
  energyMaxFor,
  getContext,
  listActivatable,
  listAskable,
  listAsks,
  moveCardTo,
  playCard,
  recycleSurcharge,
  resolveAsk,
  startBattle,
  syncPlayerEnergy,
  type EnergyConfig,
} from './battle.ts';
import { parseMachineEffect } from './schema.ts';
import { cardsInZone } from './selectors.ts';
import { evalCondition, evalNumber, evalValue } from './conditions.ts';
import { describeLimit, effectLimitUsage, effectName, effectTitle, runEffect } from './effects.ts';
import { OP_BUDGET, registerOperation, REPEAT_LIMIT, runOperations } from './operations.ts';
import { compileValue, formatValue, normalizeCondition, normalizeOperation, parseValueText, ValueError } from './值.ts';
import { explainStat, statSourceLines } from './溯源.ts';
import { createCardProvider } from './适配.ts';
import { 测试卡, 非法卡 } from './测试卡.ts';
import {
  LOG_ENTRY_LIMIT,
  LOG_LEVELS,
  POOL_EVENT_LIMIT,
  logLevelRank,
  type BattleState,
  type CardInstance,
  type CardProvider,
  type Condition,
  type OperationSpec,
} from './types.ts';

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

/** 按卡名找到战斗中的实例 */
function find(state: BattleState, name: string): CardInstance | null {
  return Object.values(state.cards).find(card => card.name === name) ?? null;
}

/** 日志里某个时点派发了几次 (全部等级都会记录, 所以事件流水都在) */
function eventCount(state: BattleState, timing: string): number {
  return state.log.filter(entry => entry.message === `时点 ${timing}`).length;
}

const { provider, errors } = createCardProvider(测试卡);

/** 建一场战斗并派发开场事件 */
interface BuildOptions {
  opening_hand?: number;
  player_hp?: number;
  enemy_hp?: number;
  recycle?: 'GRAVEYARD' | 'NONE';
  /** 用别的卡牌库建战斗 (默认用 测试卡) */
  provider?: CardProvider;
  /** 能量曲线 (省略 = 引擎缺省) */
  energy?: EnergyConfig;
  /** 手牌上限 (省略 = 不限) */
  hand_limit?: number;
  /** 每方行动开始抽几张 (省略 = 引擎缺省 1) */
  draw_per_turn?: number;
  /** 洗牌次数上限 (省略 = 不限) */
  recycle_limit?: number;
  /** 每洗一次牌的加价 (省略 = 引擎缺省 1) */
  recycle_penalty?: number;
  /** 守卫规则 (省略 = 引擎缺省 开) */
  guard?: boolean;
  /** 溢出传伤比例 (省略 = 引擎缺省 0.5) */
  splash?: number;
  /** 回合上限 (省略 = 引擎缺省 30) */
  turn_limit?: number;
}

function build(player_deck: string[], enemy_deck: string[] = [], options: BuildOptions = {}): BattleState {
  const state = createBattle({
    card_provider: options.provider ?? provider,
    player_deck,
    enemy_deck,
    seed: 42,
    opening_hand: options.opening_hand ?? 0,
    player_hp: options.player_hp,
    enemy_hp: options.enemy_hp,
    recycle: options.recycle,
    energy: options.energy,
    hand_limit: options.hand_limit,
    draw_per_turn: options.draw_per_turn,
    recycle_limit: options.recycle_limit,
    recycle_penalty: options.recycle_penalty,
    guard: options.guard,
    splash: options.splash,
    turn_limit: options.turn_limit,
  });
  startBattle(state);
  return state;
}

/** 抽牌后从手牌取出某张卡 */
function toHand(state: BattleState, player: 'PLAYER' | 'ENEMY', name: string): CardInstance {
  drawCards(state, player, cardsInZone(state, player, 'DECK').length);
  const card = cardsInZone(state, player, 'HAND').find(item => item.name === name);
  if (!card) {
    throw new Error(`手牌里没有 ${name}`);
  }
  return card;
}

/** 一张一张抽, 抽到指定的卡就停 (牌库剩下的牌留在牌库里) */
function drawUntil(state: BattleState, player: 'PLAYER' | 'ENEMY', name: string): CardInstance {
  for (let i = 0; i < 64; i += 1) {
    const found = cardsInZone(state, player, 'HAND').find(item => item.name === name);
    if (found) {
      return found;
    }
    if (drawCards(state, player, 1) === 0) {
      break;
    }
  }
  throw new Error(`抽不到 ${name}`);
}

/**
 * 写一组操作.
 *
 * 机读区里的数据是 `unknown` → zod 校验 → 编译成 AST; 这里走的是同一套编译管线,
 * 所以测试里能直接写字符串公式与结构化对象, 不必手写 AST.
 */
function ops(list: unknown[]): OperationSpec[] {
  return (list as OperationSpec[]).map((spec, index) => normalizeOperation(spec, `ops[${index}]`));
}

/** 写一个条件 (与机读区同一条路: 编译掉里面的数值) */
function cond(raw: unknown): Condition {
  return normalizeCondition(raw);
}

// ---------------------------------------------------------------------------

section('0. 机读区校验');
check('测试卡的机读区全部合法', Object.keys(errors).length === 0, errors);
{
  const 示例 = parseMachineEffect(YAML.parse(机读效果示例, { merge: true }));
  check('编辑器「插入示例」的机读效果合法', 示例.error === null, 示例.error);
  check('示例包含 7 条效果', 示例.effects.length === 7, 示例.effects.length);
}

section('1. 常驻修正只在来源卡位于场上时生效 (愿之芽)');
{
  const state = build(['愿之芽']);
  const card = cardsInZone(state, 'PLAYER', 'DECK')[0];
  check('牌库中攻击力仍是基础值 300', card.current.atk === 300, card.current.atk);
  drawCards(state, 'PLAYER', 1);
  playCard(state, card.id);
  check('进入场上后攻击力 300 + 200 = 500', card.current.atk === 500, card.current.atk);
}

section('2. 时点条件 + 代价 + 召唤 (献祭之愿 → 祈愿之星)');
{
  // 关掉洗牌: 否则第 3 回合的先手抽牌会把刚进墓地的献祭之愿洗回牌库再抽上手
  const state = build(['献祭之愿'], [], { recycle: 'NONE' });
  const sacrifice = toHand(state, 'PLAYER', '献祭之愿');
  playCard(state, sacrifice.id);
  endTurn(state);
  check('第一个回合结束时还没待够, 不发动', sacrifice.zone === 'FIELD' && find(state, '祈愿之星') === null);
  endTurn(state);
  check('第二个回合结束时献祭自身', sacrifice.zone === 'GRAVEYARD', sacrifice.zone);
  const star = find(state, '祈愿之星');
  check('召唤出祈愿之星并位于场上', star?.zone === 'FIELD', star?.zone);
  check('祈愿之星常驻修正生效 (1200 + 300)', star?.current.atk === 1500, star?.current.atk);
}

section('3. 攻击后附加带持续时间的状态 (灼热之爪 → 灼烧)');
{
  const state = build(['灼热之爪'], ['愿之芽']);
  const attacker = toHand(state, 'PLAYER', '灼热之爪');
  playCard(state, attacker.id);
  const target = toHand(state, 'ENEMY', '愿之芽');
  playCard(state, target.id);
  check('目标在场攻击力 500', target.current.atk === 500, target.current.atk);

  attack(state, attacker.id, target.id);
  check('目标获得 1 个状态', target.statuses.length === 1, target.statuses.length);
  check('灼烧使攻击力 500 - 200 = 300', target.current.atk === 300, target.current.atk);
  check('护盾先扛下 100', target.current.shield === 0, target.current.shield);
  check('溢出 600 - 100 = 500 打在生命上 (800 - 500 = 300)', target.current.hp === 300, target.current.hp);

  endTurn(state);
  endTurn(state);
  endTurn(state);
  check('3 个回合结算后灼烧消失', target.statuses.length === 0, target.statuses.length);
  check('攻击力恢复为 500', target.current.atk === 500, target.current.atk);
}

section('4. 转移生命上限 (血之契约, 到期回滚)');
{
  const state = build(['血之契约', '愿之芽']);
  const sprout = toHand(state, 'PLAYER', '愿之芽');
  playCard(state, sprout.id);
  const pact = toHand(state, 'PLAYER', '血之契约');
  playCard(state, pact.id);

  check('血之契约上限 1000 - 400 = 600', pact.current.hp_max === 600, pact.current.hp_max);
  check('当前生命被压缩到 600', pact.current.hp === 600, pact.current.hp);
  check('愿之芽上限 800 + 400 = 1200', sprout.current.hp_max === 1200, sprout.current.hp_max);

  endTurn(state);
  endTurn(state);
  check('2 个回合后上限回滚到 1000', pact.current.hp_max === 1000, pact.current.hp_max);
  check('同伴上限回滚到 800', sprout.current.hp_max === 800, sprout.current.hp_max);
}

section('5. 陷阱支付自身取消致命伤害 (深渊陷阱)');
{
  const state = build(['深渊陷阱'], ['灼热之爪']);
  const trap = toHand(state, 'PLAYER', '深渊陷阱');
  playCard(state, trap.id);
  const attacker = toHand(state, 'ENEMY', '灼热之爪');
  playCard(state, attacker.id);

  const canceled = attack(state, attacker.id, trap.id);
  check('攻击被取消', canceled === false);
  check('陷阱被支付并进入墓地', trap.zone === 'GRAVEYARD', trap.zone);
  check('陷阱没有受到伤害 (仍是 300)', trap.current.hp === 300, trap.current.hp);
}

section('6. 带条件的常驻修正 (同族之力)');
{
  const state = build(['同族之力', '愿之芽']);
  const force = toHand(state, 'PLAYER', '同族之力');
  playCard(state, force.id);
  check('场上只有 1 张祈愿时不生效 (0)', force.current.atk === 0, force.current.atk);
  const sprout = toHand(state, 'PLAYER', '愿之芽');
  playCard(state, sprout.id);
  check('场上 2 张祈愿时 +300', force.current.atk === 300, force.current.atk);
}

section('7. 机读区非法时的降级处理');
{
  const bad = createCardProvider([非法卡]);
  check('非法机读区被报告', Boolean(bad.errors['bad']), bad.errors);
  const def = bad.provider('坏掉的卡');
  check('卡牌本身仍可查询', def !== null && def.atk === 100);
  check('非法效果没有被载入', def?.effects.length === 0, def?.effects.length);
}

section('8. 可复现性');
{
  const a = build(['愿之芽', '灼热之爪', '献祭之愿']);
  const b = build(['愿之芽', '灼热之爪', '献祭之愿']);
  const order_a = cardsInZone(a, 'PLAYER', 'DECK').map(card => card.name).join(',');
  const order_b = cardsInZone(b, 'PLAYER', 'DECK').map(card => card.name).join(',');
  check('相同种子得到相同牌序', order_a === order_b, { order_a, order_b });
}

section('9. 自动攻击 (狂战之魂)');
{
  const state = build(['狂战之魂'], ['愿之芽']);
  const berserk = drawUntil(state, 'PLAYER', '狂战之魂');
  playCard(state, berserk.id);
  const sprout = drawUntil(state, 'ENEMY', '愿之芽');
  playCard(state, sprout.id);
  check('敌方满血 800', sprout.current.hp === 800, sprout.current.hp);
  check('自动攻击前可以手动攻击', attack(state, berserk.id, sprout.id));
  check('护盾 100 被吃掉后溢出的 600 打在生命上 (800 - 600 = 200)', sprout.current.hp === 200, sprout.current.hp);
  check('已攻击过, 不能再攻击', canAttack(state, berserk.id) === false);
  endTurn(state);
  check('回合结束时不会重复攻击 (仍为 200)', sprout.current.hp === 200, sprout.current.hp);
}
{
  const state = build(['狂战之魂'], ['愿之芽']);
  const berserk = drawUntil(state, 'PLAYER', '狂战之魂');
  playCard(state, berserk.id);
  const sprout = drawUntil(state, 'ENEMY', '愿之芽');
  playCard(state, sprout.id);
  endTurn(state);
  check('回合结束自动攻击 700', sprout.current.hp === 200, sprout.current.hp);
  check('不能攻击自己的卡', attack(state, berserk.id, berserk.id) === false);
  check('不能攻击我方玩家', attack(state, berserk.id, 'PLAYER') === false);
}

section('10. 玩家主动发动效果 (研究笔记)');
{
  const state = build(['研究笔记', '愿之芽', '愿之芽', '愿之芽', '愿之芽']);
  const note = drawUntil(state, 'PLAYER', '研究笔记');
  playCard(state, note.id);
  const hand_before = cardsInZone(state, 'PLAYER', 'HAND').length;
  const list = listActivatable(state);
  check('列出可发动的效果', list.length === 1 && list[0].def_id === 'study', list);
  const log_before = state.log.length;
  check('发动成功并抽 2 张', activate(state, note.id, 'study') === true);
  // 面板靠这条日志把「技能发动」的动画打到正确的卡上, 所以 detail 里必须能认出是哪张卡的哪个效果
  const effect_log = state.log.slice(log_before).filter(entry => entry.kind === 'EFFECT');
  check(
    '效果发动日志带卡实例 id 与效果 id',
    effect_log.length === 1 &&
      String(effect_log[0].detail?.card) === note.id &&
      String(effect_log[0].detail?.effect) === 'study',
    effect_log,
  );
  check('手牌多了 2 张', cardsInZone(state, 'PLAYER', 'HAND').length === hand_before + 2);
  check('每回合 1 次, 第二次发动失败', activate(state, note.id, 'study') === false);
  check('用尽后不再出现在可发动列表里', listActivatable(state).length === 0);
}
{
  const state = build(['封印之匣', '愿之芽']);
  const box = drawUntil(state, 'PLAYER', '封印之匣');
  playCard(state, box.id);
  const hp_before = state.players.PLAYER.hp;
  check('代价付不出时不发动', activate(state, box.id, 'seal') === false);
  check('生命没有变化', state.players.PLAYER.hp === hp_before);
}
{
  const state = build(['研究笔记', '研究笔记']);
  drawCards(state, 'PLAYER', 2);
  const notes = cardsInZone(state, 'PLAYER', 'HAND');
  check('两张研究笔记都抽到手上', notes.length === 2, notes.length);
  notes.forEach(note => playCard(state, note.id));
  check('两张都能各发动一次', activate(state, notes[0].id, 'study') && activate(state, notes[1].id, 'study'));
  check('同名卡的使用次数各自计算', listActivatable(state).length === 0);
}

section('11. 牌库抽空时的轮换 (薪火相传)');
{
  const state = build(['愿之芽', '薪火相传'], [], { player_hp: 1000 });
  drawCards(state, 'PLAYER', 2);
  const inherit = cardsInZone(state, 'PLAYER', 'HAND').find(card => card.name === '薪火相传');
  if (!inherit) {
    throw new Error('手牌里没有 薪火相传');
  }
  getContext(state).move(inherit, 'GRAVEYARD', { reason: 'test' });
  check('墓地里有 1 张', cardsInZone(state, 'PLAYER', 'GRAVEYARD').length === 1);
  getContext(state).damage('PLAYER', 600, null);
  check('玩家生命 400', state.players.PLAYER.hp === 400, state.players.PLAYER.hp);
  check('牌库为空', cardsInZone(state, 'PLAYER', 'DECK').length === 0);
  check('抽牌触发轮换并抽到 1 张', drawCards(state, 'PLAYER', 1) === 1);
  check('墓地已被清空', cardsInZone(state, 'PLAYER', 'GRAVEYARD').length === 0);
  check('墓地里生效的薪火相传回复了 500', state.players.PLAYER.hp === 900, state.players.PLAYER.hp);
}
{
  const state = build(['愿之芽'], [], { player_hp: 1000, recycle: 'NONE' });
  drawCards(state, 'PLAYER', 1);
  getContext(state).move(cardsInZone(state, 'PLAYER', 'HAND')[0], 'GRAVEYARD', { reason: 'test' });
  check('关闭轮换后牌库空就是抽不到', drawCards(state, 'PLAYER', 1) === 0);
}

section('12. 生命判定与胜负 (背水一战)');
{
  const state = build(['愿之芽'], ['狂战之魂'], { enemy_hp: 400 });
  const sprout = drawUntil(state, 'PLAYER', '愿之芽');
  playCard(state, sprout.id);
  check('攻击敌方玩家', attack(state, sprout.id, 'ENEMY') === true);
  check('敌方生命归零', state.players.ENEMY.hp === 0, state.players.ENEMY.hp);
  check('战斗结束且我方获胜', state.finished === true && state.winner === 'PLAYER', state.winner);
  check('结束后无法再上场', playCard(state, sprout.id) === false && canPlayCard(state, sprout.id) === false);
  check('结束后无法再攻击', attack(state, sprout.id, 'ENEMY') === false);
  const turn_before = state.turn;
  endTurn(state);
  check('结束后结束回合不再推进', state.turn === turn_before, state.turn);
}
{
  const state = build(['背水一战', '愿之芽'], [], { player_hp: 1000 });
  const field = drawUntil(state, 'PLAYER', '背水一战');
  playCard(state, field.id);
  const sprout = drawUntil(state, 'PLAYER', '愿之芽');
  playCard(state, sprout.id);
  check('满血时攻击力 500', sprout.current.atk === 500, sprout.current.atk);
  getContext(state).damage('PLAYER', 600, null);
  check('掉血发生在回合中途, 当回合不重算加成', sprout.current.atk === 500, sprout.current.atk);
  const percent = () =>
    Object.values(state.modifiers).filter(
      modifier => modifier.target === sprout.id && modifier.stat === 'atk' && modifier.layer === 'PERCENT_ADD',
    );
  endTurn(state);
  check('回合开始时血量低于一半 → +50%', sprout.current.atk === 750, sprout.current.atk);
  check('本回合的加成只有 1 条', percent().length === 1, percent().length);
  endTurn(state);
  check('duration: 1 在回合结算时被清掉 (不会滚雪球)', percent().length === 1, percent().length);
  check('下个回合重新发动, 依旧是 +50%', sprout.current.atk === 750, sprout.current.atk);
}

section('13. 状态叠加 (战意)');
{
  const state = build(['战意']);
  const spirit = drawUntil(state, 'PLAYER', '战意');
  playCard(state, spirit.id);
  check('基础攻击力 300', spirit.current.atk === 300, spirit.current.atk);
  check('第 1 层 → 400', activate(state, spirit.id, 'battle_spirit') && spirit.current.atk === 400, spirit.current.atk);
  check('第 2 层 → 500', activate(state, spirit.id, 'battle_spirit') && spirit.current.atk === 500, spirit.current.atk);
  check('第 3 层 → 600', activate(state, spirit.id, 'battle_spirit') && spirit.current.atk === 600, spirit.current.atk);
  check('场上只有 1 个战意状态', Object.values(state.statuses).length === 1, Object.keys(state.statuses));
  endTurn(state);
  endTurn(state);
  check('持续时间结束后加成回滚', spirit.current.atk === 300, spirit.current.atk);
}

section('14. 自由移动 (演习: 牌库上场 / 场上收回牌库)');
{
  const state = build(['愿之芽', '研究笔记']);
  const top = cardsInZone(state, 'PLAYER', 'DECK')[0];
  check('牌库里的卡可以直接上场', moveCardTo(state, top.id, 'FIELD') === true && top.zone === 'FIELD');
  check('上场后分配了场上位置', top.slot !== null, top.slot);
  check('上场触发了 ON_SUMMON 日志', state.log.some(entry => entry.message.includes('进入场上')), state.log.length);
  check('场上卡可以收回牌库', moveCardTo(state, top.id, 'DECK') === true && top.zone === 'DECK');
  check('收回后位置被清空', top.slot === null, top.slot);
  check('同区域移动被拒绝', moveCardTo(state, top.id, 'DECK') === false);
  check('未知卡被拒绝', moveCardTo(state, 'not-a-card', 'FIELD') === false);
  check('canMoveCardTo 与结果一致', canMoveCardTo(state, top.id, 'FIELD') === true);
}
{
  const state = build(['愿之芽', '愿之芽', '愿之芽', '愿之芽', '愿之芽', '愿之芽']);
  const deck = cardsInZone(state, 'PLAYER', 'DECK');
  for (const card of deck.slice(0, 5)) {
    moveCardTo(state, card.id, 'FIELD');
  }
  check('场上已满 5 张', cardsInZone(state, 'PLAYER', 'FIELD').length === 5, cardsInZone(state, 'PLAYER', 'FIELD').length);
  check('满场时拒绝第 6 张上场', moveCardTo(state, deck[5].id, 'FIELD') === false);
  check('被拒绝的卡仍在牌库', deck[5].zone === 'DECK', deck[5].zone);
  check('满场时 canMoveCardTo 也是 false', canMoveCardTo(state, deck[5].id, 'FIELD') === false);
}
{
  const state = build(['愿之芽'], ['愿之芽'], { enemy_hp: 1 });
  const mine = cardsInZone(state, 'PLAYER', 'DECK')[0];
  moveCardTo(state, mine.id, 'FIELD');
  attack(state, mine.id, 'ENEMY');
  check('战斗结束后禁止自由移动', moveCardTo(state, mine.id, 'DECK') === false && canMoveCardTo(state, mine.id, 'DECK') === false);
}

section('15. 触发归属 (by): 攻击后效果只认本卡自己的攻击');
{
  const state = build(['灼热之爪', '愿之芽'], ['愿之芽']);
  const claw = toHand(state, 'PLAYER', '灼热之爪');
  playCard(state, claw.id);
  const ally = toHand(state, 'PLAYER', '愿之芽');
  playCard(state, ally.id);
  const target = toHand(state, 'ENEMY', '愿之芽');
  playCard(state, target.id);

  attack(state, ally.id, target.id);
  check('同伴攻击不触发「灼热之爪」的攻击后效果', target.statuses.length === 0, target.statuses.length);
  attack(state, claw.id, target.id);
  check('本卡攻击才附加灼烧', target.statuses.length === 1, target.statuses.length);
}
{
  // by: ALLY / ENEMY — 用专门的卡建一场战斗
  const 归属 = createCardProvider([
    {
      id: 't-ally',
      name: '共鸣之印',
      hp: '1000',
      machine_effect: {
        effects: [
          {
            id: 'echo',
            on: 'AFTER_ATTACK',
            by: 'ALLY',
            operations: [{ type: 'MODIFY', target: 'SELF', stat: 'atk', value: 100 }],
          },
        ],
      },
    },
    {
      id: 't-enemy',
      name: '反击之盾',
      hp: '1000',
      machine_effect: {
        effects: [
          {
            id: 'counter',
            on: 'AFTER_ATTACK',
            by: 'ENEMY',
            operations: [{ type: 'MODIFY', target: 'SELF', stat: 'atk', value: 200 }],
          },
        ],
      },
    },
    { id: 't-rock', name: '石块', atk: '100', hp: '900' },
    { id: 't-block', name: '木桩', atk: '0', hp: '900' },
  ]);
  check('by 能通过机读区校验', Object.keys(归属.errors).length === 0, 归属.errors);

  const state = build(['共鸣之印', '反击之盾', '石块'], ['木桩'], { provider: 归属.provider });
  const rock = toHand(state, 'PLAYER', '石块');
  playCard(state, rock.id);
  const echo = toHand(state, 'PLAYER', '共鸣之印');
  playCard(state, echo.id);
  const counter = toHand(state, 'PLAYER', '反击之盾');
  playCard(state, counter.id);
  const block = toHand(state, 'ENEMY', '木桩');
  playCard(state, block.id);

  attack(state, rock.id, block.id);
  check('by: ALLY — 我方其他卡攻击时触发', echo.current.atk === 100, echo.current.atk);
  check('by: ENEMY — 我方卡攻击时不触发', counter.current.atk === 0, counter.current.atk);

  attack(state, block.id, rock.id);
  check('by: ENEMY — 对手的卡攻击时触发', counter.current.atk === 200, counter.current.atk);
}

section('16. 护盾池 (护盾先扣 / 溢出到生命 / 护盾清零)');
{
  const state = build(['壁垒之核'], ['愿之芽']);
  const core = toHand(state, 'PLAYER', '壁垒之核');
  playCard(state, core.id);
  const foe = toHand(state, 'ENEMY', '愿之芽');
  playCard(state, foe.id);

  check('初始护盾 = 基础护盾 300', core.current.shield === 300 && core.current.shield_max === 300, core.current);
  check('破盾前攻击力 0', core.current.atk === 0, core.current.atk);

  // 愿之芽上场后攻击力 500: 300 被护盾扛下, 200 溢出到生命
  attack(state, foe.id, core.id);
  check('护盾先扛伤害并被打空', core.current.shield === 0, core.current.shield);
  check('溢出 200 打在生命上 (500 - 200 = 300)', core.current.hp === 300, core.current.hp);
  check('破盾那一刻触发 SHIELD_BROKEN (攻击力 0 → 300)', core.current.atk === 300, core.current.atk);

  endTurn(state);
  check('回合结算时恢复 150 护盾', core.current.shield === 150, core.current.shield);
  endTurn(state);
  check('再一个回合结算后回满 (上限 300)', core.current.shield === 300, core.current.shield);

  attack(state, foe.id, core.id);
  check('重新张的盾又被吃光', core.current.shield === 0, core.current.shield);
  check('溢出 200 打在生命上 (300 - 200 = 100)', core.current.hp === 100, core.current.hp);
  check(
    '破盾事件可以反复触发 (重新张盾后重置)',
    state.log.filter(entry => entry.message === '时点 SHIELD_BROKEN').length === 2,
    state.log.filter(entry => entry.message === '时点 SHIELD_BROKEN').length,
  );
}
{
  // 穿盾伤害 / 护盾上限 / 护盾清零 — 用专门的卡建一场战斗
  const 护盾 = createCardProvider([
    {
      id: 's-stone',
      name: '石板',
      atk: '0',
      shield: '500',
      hp: '2000',
      machine_effect: {
        effects: [
          {
            id: 'reinforce',
            on: 'MANUAL',
            operations: [
              { type: 'MODIFY', target: 'SELF', stat: 'shield_max', value: 200 },
              { type: 'RESTORE_SHIELD', target: 'SELF', value: 9999 },
            ],
          },
          {
            id: 'shatter',
            on: 'SHIELD_BROKEN',
            operations: [{ type: 'MODIFY', target: 'SELF', stat: 'atk', value: 100 }],
          },
        ],
      },
    },
    {
      id: 's-pierce',
      name: '穿甲矛',
      atk: '400',
      shield: '0',
      hp: '800',
      machine_effect: {
        effects: [
          {
            id: 'lunge',
            on: 'MANUAL',
            operations: [{ type: 'DAMAGE', target: 'ALL_ENEMIES', value: 300, pierce: true }],
          },
        ],
      },
    },
    {
      id: 's-pick',
      name: '破盾镐',
      atk: '0',
      shield: '0',
      hp: '800',
      machine_effect: {
        effects: [{ id: 'breaker', on: 'MANUAL', operations: [{ type: 'CLEAR_SHIELD', target: 'ALL_ENEMIES' }] }],
      },
    },
  ]);
  check('穿盾 / 清盾 / 护盾上限的机读区能通过校验', Object.keys(护盾.errors).length === 0, 护盾.errors);

  const state = build(['石板', '穿甲矛'], ['石板', '破盾镐'], { provider: 护盾.provider });
  const stone = toHand(state, 'PLAYER', '石板');
  playCard(state, stone.id);
  const spear = toHand(state, 'PLAYER', '穿甲矛');
  playCard(state, spear.id);
  const foe_stone = toHand(state, 'ENEMY', '石板');
  playCard(state, foe_stone.id);
  const foe_pick = toHand(state, 'ENEMY', '破盾镐');
  playCard(state, foe_pick.id);

  activate(state, spear.id, 'lunge');
  check('pierce 无视护盾 (护盾一点也不掉)', foe_stone.current.shield === 500, foe_stone.current.shield);
  check('pierce 直击生命 300', foe_stone.current.hp === 1700, foe_stone.current.hp);

  activate(state, stone.id, 'reinforce');
  check('护盾上限 500 + 200 = 700', stone.current.shield_max === 700, stone.current.shield_max);
  check('恢复护盾被上限截断 (9999 → 700)', stone.current.shield === 700, stone.current.shield);

  activate(state, foe_pick.id, 'breaker');
  check('护盾清零: 护盾直接归零', stone.current.shield === 0, stone.current.shield);
  check('清零不影响生命', stone.current.hp === 2000, stone.current.hp);
  check('清零也会触发 SHIELD_BROKEN (+100 攻击力)', stone.current.atk === 100, stone.current.atk);
  check('没有护盾的卡不会被清零 (仍为 0)', spear.current.shield === 0, spear.current.shield);

  activate(state, stone.id, 'reinforce');
  check('破盾后可以重新恢复护盾 (上限 900 → 补满 900)', stone.current.shield === 900, stone.current.shield);
  activate(state, foe_pick.id, 'breaker');
  check('再次清零会再次触发 SHIELD_BROKEN (+100)', stone.current.atk === 200, stone.current.atk);
}

section('17. 回合推进与换边 (一个回合 = 双方各行动一次)');
{
  const state = build(['愿之芽'], ['愿之芽']);
  check(
    '开局: 第 1 回合 · 我方先手 · 先手方是我方',
    state.turn === 1 && state.first_side === 'PLAYER' && state.active === 'PLAYER' && state.active_index === 0,
    { turn: state.turn, active: state.active, index: state.active_index },
  );
  check(
    '开局派发 TURN_START + 我方 SIDE_START, 还没有换边',
    eventCount(state, 'TURN_START') === 1 && eventCount(state, 'SIDE_START') === 1 && eventCount(state, 'SIDE_CHANGE') === 0,
  );
  check('不是当前行动方时 endSide 无效', endSide(state, 'ENEMY') === false && state.active === 'PLAYER');

  check(
    '我方收手 → 换边给敌方, 但回合还是第 1 回合',
    endSide(state) === true && state.active === 'ENEMY' && state.active_index === 1 && state.turn === 1,
    { active: state.active, turn: state.turn },
  );
  check(
    '换边派发了 SIDE_END + SIDE_CHANGE + SIDE_START',
    eventCount(state, 'SIDE_END') === 1 && eventCount(state, 'SIDE_CHANGE') === 1 && eventCount(state, 'SIDE_START') === 2,
    { end: eventCount(state, 'SIDE_END'), change: eventCount(state, 'SIDE_CHANGE'), start: eventCount(state, 'SIDE_START') },
  );

  check('敌方收手 → 进入回合结算', endSide(state) === true && eventCount(state, 'TURN_END') === 1);
  check(
    '新回合: 回合号 +1 且回到先手方, 行动序号归零',
    state.turn === 2 && state.active === 'PLAYER' && state.active_index === 0,
    { turn: state.turn, active: state.active, index: state.active_index },
  );
  check(
    '每个回合各 1 次 TURN_START / TURN_END',
    eventCount(state, 'TURN_START') === 2 && eventCount(state, 'TURN_END') === 1,
    { start: eventCount(state, 'TURN_START'), end: eventCount(state, 'TURN_END') },
  );
  check('一个回合里 SIDE_CHANGE 派发 2 次', eventCount(state, 'SIDE_CHANGE') === 2, eventCount(state, 'SIDE_CHANGE'));
  check(
    'SIDE_START 3 次 / SIDE_END 2 次 (开局那次没有收手)',
    eventCount(state, 'SIDE_START') === 3 && eventCount(state, 'SIDE_END') === 2,
    { start: eventCount(state, 'SIDE_START'), end: eventCount(state, 'SIDE_END') },
  );

  const change = state.log.find(entry => entry.message === '时点 SIDE_CHANGE');
  check('换边事件的归属方 = 接手方', change?.detail?.owner === 'ENEMY', change?.detail);
  const round_end = state.log.find(entry => entry.message === '时点 TURN_END');
  check('回合结算没有归属方 (when: CONTROLLER 在这里不生效)', round_end?.detail?.owner === null, round_end?.detail);

  endTurn(state);
  check('endTurn 一次推完整个回合', state.turn === 3 && state.active === 'PLAYER', state.turn);
  check(
    'endTurn 也是一次换边 + 回合结算 + 新回合换边',
    eventCount(state, 'SIDE_CHANGE') === 4 && eventCount(state, 'TURN_END') === 2,
    { change: eventCount(state, 'SIDE_CHANGE'), end: eventCount(state, 'TURN_END') },
  );
}

section('18. 换边触发器 (换防号令: SIDE_CHANGE + when)');
{
  const state = build(['换防号令']);
  const relay = toHand(state, 'PLAYER', '换防号令');
  playCard(state, relay.id);
  check('换边前攻击力 0', relay.current.atk === 0, relay.current.atk);

  endSide(state);
  check('换到敌方那一次不发动 (when: CONTROLLER 挡住了)', relay.current.atk === 0, relay.current.atk);

  endSide(state);
  check('回合结算后换到我方 → 全体 +50', relay.current.atk === 50, relay.current.atk);

  endTurn(state);
  check('再过一个回合又 +50 (永久叠加到 100)', relay.current.atk === 100, relay.current.atk);
  check('触发的是换边而不是回合结束', eventCount(state, 'SIDE_CHANGE') === 4, eventCount(state, 'SIDE_CHANGE'));
}

section('19. 回合制持续伤害 (凋零之咒: 状态挂在 TURN_END 上)');
{
  const state = build(['凋零之咒'], ['愿之芽']);
  const foe = toHand(state, 'ENEMY', '愿之芽');
  playCard(state, foe.id);
  check('对手满血 800', foe.current.hp === 800, foe.current.hp);

  const curse = toHand(state, 'PLAYER', '凋零之咒');
  playCard(state, curse.id);
  check('上场时给对手挂上凋零', foe.statuses.length === 1, foe.statuses.length);
  check('两边的行动阶段里不掉血', foe.current.hp === 800, foe.current.hp);

  endTurn(state);
  check('回合结算时受到 100 点穿透伤害', foe.current.hp === 700, foe.current.hp);
  check('穿透伤害不消耗护盾 (仍是 100)', foe.current.shield === 100, foe.current.shield);
  const status = state.statuses[foe.statuses[0]];
  check('凋零还剩 1 回合', status?.expiry?.remaining === 1, status?.expiry);

  endTurn(state);
  check('持续 2 回合后凋零消失', foe.statuses.length === 0, foe.statuses.length);
  check('总共掉了 200 生命', foe.current.hp === 600, foe.current.hp);

  endTurn(state);
  check('消失后不再掉血', foe.current.hp === 600, foe.current.hp);
}

section('20. 日志分级 (DEBUG / INFO / WARN / ERROR) 与体积上限');
{
  const state = build(['愿之芽']);
  check('没有「记录阈值」这个开关了', !('log_level' in state), Object.keys(state));
  check('事件流水记为 DEBUG', state.log.some(entry => entry.kind === 'EVENT' && entry.level === 'DEBUG'));
  check('DEBUG 也被记了下来 (面板切到调试就能回看)', state.log.some(entry => entry.level === 'DEBUG'));
  check('事件流水确实在日志里', eventCount(state, 'TURN_START') > 0, eventCount(state, 'TURN_START'));
  check('战斗过程记为 INFO', state.log.some(entry => entry.level === 'INFO'));
  check('时序 / COMBAT 等非事件日志不再是未知等级', state.log.every(entry => LOG_LEVELS.includes(entry.level)));
  check('等级常量可以排序', logLevelRank('ERROR') > logLevelRank('WARN') && logLevelRank('WARN') > logLevelRank('INFO'));
  check('INFO 高于 DEBUG', logLevelRank('INFO') > logLevelRank('DEBUG'));
}

{
  // 引擎内部问题 (卡牌库缺卡): 记在日志里, 但带 engine_only 标记 → 不进 AI 简报
  const state = build(['愿之芽', '这张卡不存在']);
  const warned = state.log.filter(entry => entry.level === 'WARN');
  check('卡牌库缺卡记为 WARN', warned.some(entry => entry.message.includes('找不到')), warned.map(entry => entry.message));
  check(
    '缺卡属于引擎内部问题 (面板能看, 但不发给 AI)',
    warned.length === 1 && warned[0].engine_only === true,
    warned,
  );
  check('普通日志不带 engine_only 标记', state.log.some(entry => entry.engine_only === undefined));
}

{
  // 与操作相关的警告相反: 这些 AI 是要读的
  const state = build(['愿之芽']);
  const sprout = toHand(state, 'PLAYER', '愿之芽');
  playCard(state, sprout.id);
  const before = state.log.length;
  check('无效目标打不中', attack(state, sprout.id, 'not-a-card') === false);
  const warned = state.log.slice(before).filter(entry => entry.level === 'WARN');
  check('无效的攻击目标记为 WARN', warned.length === 1 && warned[0].message.includes('无效的攻击目标'), warned);
  check('这类警告没有 engine_only 标记 (会进简报)', warned[0].engine_only === undefined);
}

{
  // 长局: 超过上限后从最旧的开始丢, 但 WARN / ERROR 永远保留
  const state = build(['愿之芽']);
  const sprout = toHand(state, 'PLAYER', '愿之芽');
  playCard(state, sprout.id);
  attack(state, sprout.id, 'not-a-card');
  const oldest = state.log[0];
  const warnings = state.log.filter(entry => entry.level === 'WARN').length;
  check('先记下一条警告', warnings === 1, warnings);

  for (let index = 0; index < LOG_ENTRY_LIMIT; index += 1) {
    // 场上 ⇄ 手牌来回搬: 每次移动都会写 ZONE (INFO) 与事件流水 (DEBUG)
    moveCardTo(state, sprout.id, 'HAND');
    moveCardTo(state, sprout.id, 'FIELD');
  }
  check('日志长度被压回上限', state.log.length === LOG_ENTRY_LIMIT, state.log.length);
  check('最旧的日志已被丢掉', !state.log.includes(oldest));
  check(
    'WARN 永远保留 (不被事件流水挤掉)',
    state.log.filter(entry => entry.level === 'WARN').length === warnings,
    state.log.filter(entry => entry.level === 'WARN').map(entry => entry.message),
  );
  check('剩下的仍然是最近的 (DEBUG 先被丢)', state.log.some(entry => entry.level === 'DEBUG'));
}

section('21. 加成来源溯源 (explainStat / statSourceLines)');
{
  const state = build(['愿之芽']);
  const sprout = toHand(state, 'PLAYER', '愿之芽');
  playCard(state, sprout.id);
  check('ATK 基础 300 + 常驻 200 = 500', sprout.current.atk === 500, sprout.current.atk);

  const atk = explainStat(state, sprout, 'atk');
  check('溯源拆出基础值', atk.base === 300 && atk.delta === 200, atk);
  check('只有一条贡献', atk.contributions.length === 1, atk.contributions.length);
  check('贡献带上了来源卡牌 id', atk.contributions[0].source.card_id === sprout.id, atk.contributions[0].source);
  check('来源文本可读', atk.contributions[0].source.text === '「愿之芽」', atk.contributions[0].source.text);
  check('贡献此刻是生效的', atk.contributions[0].active === true && atk.contributions[0].reason === null);
  check('池值不参与溯源 (护盾由伤害直接改写)', explainStat(state, sprout, 'hp').pool === true);

  const lines = statSourceLines(state, sprout);
  check('压成一行面板文本', lines.length === 1 && lines[0] === 'ATK +200 ← 「愿之芽」', lines);
}
{
  // 条件不满足的加成: 也能看到来源, 只是标为未生效
  const state = build(['同族之力', '愿之芽']);
  const force = toHand(state, 'PLAYER', '同族之力');
  playCard(state, force.id);
  const atk = explainStat(state, force, 'atk');
  check('条件不满足时不生效, 但依然能看到来源', atk.contributions.length === 1 && atk.contributions[0].active === false);
  check('并给出了「条件不满足」的原因', atk.contributions[0].reason === '条件不满足', atk.contributions[0].reason);
  check('未生效的加成默认不出现在面板文本里', statSourceLines(state, force).length === 0);
  check('需要时才列出未生效的', statSourceLines(state, force, { include_inactive: true }).length === 1);

  const sprout = toHand(state, 'PLAYER', '愿之芽');
  playCard(state, sprout.id);
  check('凑够两张祈愿系列后开始生效 (ATK 300)', force.current.atk === 300, force.current.atk);
  check(
    '面板文本里出现了加成来源',
    statSourceLines(state, force).some(line => line.includes('「同族之力」')),
    statSourceLines(state, force),
  );
}
{
  // 状态带来的减值: 要能追溯回「哪张卡的哪条技能」
  const state = build(['灼热之爪'], ['愿之芽']);
  const claw = drawUntil(state, 'PLAYER', '灼热之爪');
  playCard(state, claw.id);
  const sprout = drawUntil(state, 'ENEMY', '愿之芽');
  playCard(state, sprout.id);
  check('对手 ATK 500 (300 + 常驻 200)', sprout.current.atk === 500, sprout.current.atk);
  attack(state, claw.id, sprout.id);
  check('灼烧使对手 ATK -200', sprout.current.atk === 300, sprout.current.atk);

  const atk = explainStat(state, sprout, 'atk');
  check('两条贡献: 常驻 +200 与 状态 -200', atk.contributions.length === 2, atk.contributions);
  const burn = atk.contributions.find(contribution => contribution.amount === -200);
  check('减值的来源是施加者而不是受害者', burn?.source.card_id === claw.id, burn?.source);
  check('同时指出状态名', burn?.source.text === '「灼热之爪」 · 灼烧', burn?.source.text);
  check('带上了剩余回合数', burn?.remaining === 3, burn?.remaining);
  check('两条都在生效, 先列出的还是常驻加成', atk.contributions[0].amount === 200, atk.contributions);
  const lines = statSourceLines(state, sprout);
  check('面板文本包含两条', lines.length === 2 && lines.some(line => line.includes('「灼热之爪」 · 灼烧')), lines);
}

section('22. 值表达式 (算术 / 聚合 / 事件 / 随机 / 分支)');
{
  const state = build(['愿之芽'], ['愿之芽']);
  const mine = toHand(state, 'PLAYER', '愿之芽');
  playCard(state, mine.id);
  const foe = toHand(state, 'ENEMY', '愿之芽');
  playCard(state, foe.id);

  const ctx = getContext(state);
  const scope = ctx.makeScope(mine, 'PLAYER');
  const num = (text: string) => evalValue(parseValueText(text), scope);

  // 算术: 字符串公式
  check('字符串公式: SELF.atk / 2 = 250', num('SELF.atk / 2') === 250, num('SELF.atk / 2'));
  check('省略目标时默认取自己 (atk = SELF.atk)', num('atk / 2') === 250, num('atk / 2'));
  check('括号与优先级', num('(1 + 2) * 3') === 9, num('(1 + 2) * 3'));
  check('取模', num('10 % 4') === 2, num('10 % 4'));
  check('幂运算 ^ 与 POW() 等价', num('2 ^ 10') === 1024 && num('POW(2, 10)') === 1024, num('2 ^ 10'));
  check('一元负号', num('-SELF.atk') === -500, num('-SELF.atk'));
  check('函数式一元运算', num('ABS(0 - 5)') === 5 && num('FLOOR(7 / 2)') === 3 && num('ROUND(2.6)') === 3, {
    abs: num('ABS(0 - 5)'),
    floor: num('FLOOR(7 / 2)'),
    round: num('ROUND(2.6)'),
  });
  check('MIN / MAX 普通取极值', num('MIN(3, 7)') === 3 && num('MAX(3, 7)') === 7);
  check('除零与取模零都当 0 (不会抛异常 / NaN)', num('5 / 0') === 0 && num('5 % 0') === 0, {
    div: num('5 / 0'),
    mod: num('5 % 0'),
  });

  // 读数值
  check('读自己的各项数值', num('SELF.hp_max') === 800 && num('SELF.shield') === 100 && num('SELF.hp') === 800);
  check('读别人/玩家的数值', num('OPPONENT.hp') === 8000 && num('ALL_FIELD.atk') === 500, {
    opponent: num('OPPONENT.hp'),
    field: num('ALL_FIELD.atk'),
  });
  check('回合数', num('TURN') === state.turn, num('TURN'));
  check('没有事件时 EVENT.value / EVENT.lethal 都是 0', num('EVENT.value') === 0 && num('EVENT.lethal') === 0);
  check('没有目标时取 0 (EVENT_TARGET 此刻不存在)', num('EVENT_TARGET.hp') === 0, num('EVENT_TARGET.hp'));
  check('没写过的变量是 0', num('$没有这个变量') === 0);

  // 聚合
  check('COUNT 数目标个数', num('COUNT(ALL_ENEMIES)') === 1, num('COUNT(ALL_ENEMIES)'));
  check('SUM 全场攻击力之和', num('SUM(ALL_FIELD, atk)') === 1000, num('SUM(ALL_FIELD, atk)'));
  check('AVG 取平均', num('AVG(ALL_FIELD, atk)') === 500, num('AVG(ALL_FIELD, atk)'));
  check('MAX(ALL_FIELD, hp) 是聚合 (全场最高生命)', num('MAX(ALL_FIELD, hp)') === 800, num('MAX(ALL_FIELD, hp)'));
  check(
    'MIN/MAX 带单个目标.字段 也是聚合, 带两个值才是普通取极值',
    num('MAX(SELF.atk)') === 500 && num('MAX(SELF.atk, 400)') === 500 && num('MIN(SELF.atk, 400)') === 400,
    { agg: num('MAX(SELF.atk)'), plain: num('MAX(SELF.atk, 400)') },
  );

  // 结构化写法 (与字符串糖编译到同一棵树)
  check(
    '结构化写法与字符串糖等价',
    evalValue(compileValue({ op: 'DIV', args: [{ stat: 'atk', of: 'SELF' }, 2] }), scope) === num('SELF.atk / 2'),
  );
  check(
    '结构化聚合',
    evalValue(compileValue({ agg: 'SUM', of: 'ALL_FIELD', stat: 'atk' }), scope) === 1000,
  );
  check('结构化回合数 / 变量', evalValue(compileValue({ turn: true }), scope) === state.turn && evalValue(compileValue({ var: '未定义' }), scope) === 0);

  // { if } 取值
  const pick = compileValue({ if: { var: 'score', op: '>=', value: 2 }, then: 10, else: 1 });
  check('{ if } 条件不成立取 else', evalValue(pick, scope) === 1, evalValue(pick, scope));
  runOperations(ctx, ops([{ type: 'SET_VAR', var: 'score', value: 3 }]));
  check('{ if } 条件成立取 then', evalValue(pick, scope) === 10, evalValue(pick, scope));

  // evalNumber 对常量走快速路径
  check('evalNumber 直接吃常量', evalNumber(3, scope) === 3 && evalNumber(compileValue('SELF.atk / 4'), scope) === 125);

  check('formatValue 能把 AST 还原成一行 (调试面板用)', formatValue(compileValue('SELF.atk / 2')).includes('DIV'), formatValue(compileValue('SELF.atk / 2')));

  let threw = false;
  try {
    parseValueText('SELF.atk /');
  } catch (error) {
    threw = error instanceof ValueError;
  }
  check('写错的公式抛 ValueError (带位置信息, 保存卡牌时就报出来)', threw);

  // 随机数按种子复现
  const r1 = build(['愿之芽']);
  const r2 = build(['愿之芽']);
  const roll = (state2: BattleState) =>
    evalValue(compileValue({ random: true }), getContext(state2).makeScope(null, 'PLAYER'));
  check('相同种子得到相同随机数 (回放可复现)', roll(r1) === roll(r2) && roll(r1) >= 0 && roll(r1) < 1, {
    a: roll(r1),
    b: roll(r2),
  });
}

section('23. 变量与效果帧 (EFFECT / BATTLE / 子效果读父效果)');
{
  const state = build(['愿之芽']);
  const mine = toHand(state, 'PLAYER', '愿之芽');
  playCard(state, mine.id);
  const ctx = getContext(state);
  ctx.source = mine;
  ctx.controller = 'PLAYER';
  const scope = ctx.makeScope(mine, 'PLAYER');

  runOperations(ctx, ops([{ type: 'SET_VAR', var: 'tmp', value: 3 }]));
  check('SET_VAR 默认写效果局部', ctx.readVar('tmp') === 3, ctx.readVar('tmp'));
  check('战斗级池里没有它 (不会污染快照)', state.vars.tmp === undefined, state.vars);
  check('表达式能读到 ($tmp * 2)', evalValue(parseValueText('$tmp * 2'), scope) === 6);
  check('var 条件能读到', evalCondition(cond({ var: 'tmp', op: '=', value: 3 }), scope));

  runOperations(ctx, ops([{ type: 'SET_VAR', var: 'marks', value: 5, scope: 'BATTLE' }]));
  check('SET_VAR scope: BATTLE 写进战斗状态', state.vars.marks === 5, state.vars);
  runOperations(ctx, ops([{ type: 'ADD_VAR', var: 'marks', value: 2, scope: 'BATTLE' }]));
  check('ADD_VAR 在旧值上累加', state.vars.marks === 7, state.vars);
  check('战斗级变量随状态序列化 (进聊天变量)', JSON.stringify(state.vars).includes('"marks":7'));
  check('var 条件省略 scope 时读得到战斗级', evalCondition(cond({ var: 'marks', op: '>=', value: 7 }), scope));
  check('写 BATTLE 变量时局部不会跟着变', ctx.readVar('marks', 'EFFECT') === 7, ctx.readVar('marks', 'EFFECT'));

  // 效果帧: 父效果写的变量, 子效果 (被父效果触发的事件) 读得到; 父效果结束后消失
  let read_mark: number | null = null;
  registerOperation('TEST_SET_MARK', inner => {
    inner.writeVar('mark', 7);
    return true;
  });
  registerOperation('TEST_READ_MARK', inner => {
    read_mark = inner.readVar('mark');
    return true;
  });
  ctx.createEffect(
    { on: 'BEFORE_DAMAGE', operations: [{ type: 'TEST_READ_MARK' }] },
    { source: mine.id, controller: 'PLAYER' },
  );
  const parent = ctx.createEffect(
    { operations: [{ type: 'TEST_SET_MARK' }, { type: 'DAMAGE', target: 'SELF', value: 10 }] },
    { source: mine.id, controller: 'PLAYER' },
  );
  check('父效果结算成功', runEffect(ctx, parent) === true);
  check('子效果读到了父效果写的局部变量', read_mark === 7, read_mark);
  check('效果结束后局部变量消失', ctx.readVar('mark') === 0, ctx.readVar('mark'));
}

section('24. 控制流 (IF / FOR_EACH / REPEAT / BREAK / STOP 与上限)');
{
  const state = build(['愿之芽'], ['愿之芽', '愿之芽']);
  const ctx = getContext(state);
  const mine = toHand(state, 'PLAYER', '愿之芽');
  playCard(state, mine.id);
  const foe_a = drawUntil(state, 'ENEMY', '愿之芽');
  playCard(state, foe_a.id);
  const foe_b = drawUntil(state, 'ENEMY', '愿之芽');
  playCard(state, foe_b.id);
  ctx.source = mine;
  ctx.controller = 'PLAYER';

  // IF
  runOperations(
    ctx,
    ops([
      { type: 'SET_VAR', var: 'hit', value: 0 },
      {
        type: 'IF',
        condition: { var: 'hit', op: '>=', value: 1 },
        then: [{ type: 'SET_VAR', var: 'hit', value: 100 }],
        else: [{ type: 'SET_VAR', var: 'hit', value: 7 }],
      },
    ]),
  );
  check('IF 条件不成立走 else', ctx.readVar('hit') === 7, ctx.readVar('hit'));
  runOperations(
    ctx,
    ops([
      {
        type: 'IF',
        condition: { var: 'hit', op: '=', value: 7 },
        then: [{ type: 'SET_VAR', var: 'hit', value: 100 }],
        else: [{ type: 'SET_VAR', var: 'hit', value: 0 }],
      },
    ]),
  );
  check('IF 条件成立走 then', ctx.readVar('hit') === 100, ctx.readVar('hit'));

  // FOR_EACH
  runOperations(
    ctx,
    ops([
      { type: 'SET_VAR', var: 'count', value: 0 },
      {
        type: 'FOR_EACH',
        target: 'ALL_ENEMIES',
        operations: [
          { type: 'DAMAGE', target: 'LOOP_ITEM', value: '($index + 1) * 100' },
          { type: 'ADD_VAR', var: 'count', value: 1 },
        ],
      },
    ]),
  );
  check('FOR_EACH 遍历了敌方每一张', ctx.readVar('count') === 2, ctx.readVar('count'));
  check(
    '$index 从 0 开始: 第一张吃 100',
    foe_a.current.shield === 0 && foe_a.current.hp === 800,
    { shield: foe_a.current.shield, hp: foe_a.current.hp },
  );
  check(
    '第二张吃 200',
    foe_b.current.shield === 0 && foe_b.current.hp === 700,
    { shield: foe_b.current.shield, hp: foe_b.current.hp },
  );

  runOperations(
    ctx,
    ops([
      { type: 'SET_VAR', var: 'count', value: 0 },
      {
        type: 'FOR_EACH',
        target: 'ALL_ENEMIES',
        max: 1,
        operations: [{ type: 'ADD_VAR', var: 'count', value: 1 }],
      },
    ]),
  );
  check('FOR_EACH max 限制处理数量', ctx.readVar('count') === 1, ctx.readVar('count'));

  runOperations(
    ctx,
    ops([
      { type: 'SET_VAR', var: 'count', value: 0 },
      {
        type: 'FOR_EACH',
        target: 'ALL_ENEMIES',
        max: 999,
        operations: [{ type: 'ADD_VAR', var: 'count', value: 1 }],
      },
    ]),
  );
  check('max 写得再大也只处理存在的目标', ctx.readVar('count') === 2, ctx.readVar('count'));

  // break_if / BREAK
  runOperations(
    ctx,
    ops([
      { type: 'SET_VAR', var: 'count', value: 0 },
      {
        type: 'FOR_EACH',
        target: 'ALL_ENEMIES',
        operations: [{ type: 'ADD_VAR', var: 'count', value: 1 }],
        break_if: { var: 'count', op: '>=', value: 1 },
      },
    ]),
  );
  check('break_if 成立就提前跳出 (没跑满两张)', ctx.readVar('count') === 1, ctx.readVar('count'));

  runOperations(
    ctx,
    ops([
      { type: 'SET_VAR', var: 'count', value: 0 },
      {
        type: 'FOR_EACH',
        target: 'ALL_ENEMIES',
        operations: [{ type: 'ADD_VAR', var: 'count', value: 1 }, { type: 'BREAK' }],
      },
    ]),
  );
  check('BREAK 跳出最内层循环', ctx.readVar('count') === 1, ctx.readVar('count'));

  // REPEAT
  runOperations(
    ctx,
    ops([
      { type: 'SET_VAR', var: 'total', value: 0 },
      { type: 'REPEAT', times: 5, operations: [{ type: 'ADD_VAR', var: 'total', value: '$round + 1' }] },
    ]),
  );
  check('REPEAT 跑 5 轮, $round 从 0 开始 (1+2+3+4+5)', ctx.readVar('total') === 15, ctx.readVar('total'));

  runOperations(
    ctx,
    ops([
      { type: 'SET_VAR', var: 'cap', value: 0 },
      { type: 'REPEAT', times: 1000, operations: [{ type: 'ADD_VAR', var: 'cap', value: 1 }] },
    ]),
  );
  check(`REPEAT 单次最多 ${REPEAT_LIMIT} 轮`, ctx.readVar('cap') === REPEAT_LIMIT, ctx.readVar('cap'));

  // 嵌套深度
  const nest = (depth: number): OperationSpec =>
    depth === 0
      ? { type: 'ADD_VAR', var: 'deep', value: 1 }
      : { type: 'FOR_EACH', target: 'SELF', operations: [nest(depth - 1)] };
  runOperations(ctx, [nest(4)]);
  check('4 层嵌套可以跑', ctx.readVar('deep') === 1, ctx.readVar('deep'));
  runOperations(ctx, [nest(5)]);
  check('超过 4 层的部分被跳过', ctx.readVar('deep') === 1, ctx.readVar('deep'));
  check('并留了一条警告', state.log.some(entry => entry.message.includes('嵌套超过')), state.log.slice(-4).map(entry => entry.message));

  // STOP
  runOperations(
    ctx,
    ops([
      { type: 'SET_VAR', var: 'before_stop', value: 1 },
      { type: 'STOP' },
      { type: 'SET_VAR', var: 'after_stop', value: 1 },
    ]),
  );
  check(
    'STOP 停掉本效果剩下的操作',
    ctx.readVar('before_stop') === 1 && ctx.readVar('after_stop') === 0,
    { before: ctx.readVar('before_stop'), after: ctx.readVar('after_stop') },
  );
  // 真正的效果结算会由 runEffect 复位这两个开关; 这里手动复位, 免得影响后面的测试
  ctx.stopped = false;

  // 操作数预算: 就算循环里塞了成百上千个操作, 也只会结算到上限就收手 (防卡死)
  ctx.op_count = 0;
  runOperations(
    ctx,
    ops([
      { type: 'SET_VAR', var: 'n', value: 0 },
      {
        type: 'REPEAT',
        times: REPEAT_LIMIT,
        operations: Array.from({ length: 15 }, () => ({ type: 'ADD_VAR', var: 'n', value: 1 })),
      },
    ]),
  );
  check(
    `单个效果最多结算 ${OP_BUDGET} 个操作, 循环被预算掐断 (不会拖死界面)`,
    ctx.readVar('n') === OP_BUDGET - 2,
    ctx.readVar('n'),
  );
  check(
    '并且只留一条警告 (不会刷满日志)',
    state.log.filter(entry => entry.message.includes('操作数超过')).length === 1,
    state.log.slice(-3).map(entry => entry.message),
  );
}

section('25. 多步决策 (先打一下, 看死没死, 再决定要不要弃牌)');
{
  // 同一条决策流程跑两遍: 伤害小的时候它活着 (走 then), 伤害大的时候它没了 (走 else)
  const decide = (damage: number) => {
    const state = build(['灼热之爪'], ['愿之芽']);
    const claw = drawUntil(state, 'PLAYER', '灼热之爪');
    playCard(state, claw.id);
    const sprout = drawUntil(state, 'ENEMY', '愿之芽');
    playCard(state, sprout.id);
    const ctx = getContext(state);
    ctx.source = claw;
    ctx.controller = 'PLAYER';
    runOperations(
      ctx,
      ops([
        { type: 'SET_VAR', var: 'alive', value: 0 },
        { type: 'DAMAGE', target: { id: sprout.id }, value: damage },
        {
          type: 'IF',
          // 「它现在还在场上吗」—— 条件读的是刚刚那一下的结果
          condition: { target: { of: { id: sprout.id }, zone: 'FIELD' } },
          then: [{ type: 'SET_VAR', var: 'alive', value: 1 }],
          else: [{ type: 'SET_VAR', var: 'alive', value: -1 }],
        },
      ]),
    );
    return { state, ctx, sprout };
  };

  const survived = decide(200);
  check('打 200: 护盾先扛下 100, 溢出 100 打在生命上', survived.sprout.current.shield === 0 && survived.sprout.current.hp === 700, {
    shield: survived.sprout.current.shield,
    hp: survived.sprout.current.hp,
  });
  check('它还在场上 → 条件成立, 走 then', survived.ctx.readVar('alive') === 1, survived.ctx.readVar('alive'));

  const killed = decide(1000);
  check('打 1000: 它被破坏了', killed.sprout.zone === 'GRAVEYARD', killed.sprout.zone);
  check('条件不成立 → 走 else (这里就代表「弃牌」那一步)', killed.ctx.readVar('alive') === -1, killed.ctx.readVar('alive'));

  // 同一个条件还能反过来问「一个都没死」
  const state = build(['灼热之爪'], ['愿之芽']);
  const claw = drawUntil(state, 'PLAYER', '灼热之爪');
  playCard(state, claw.id);
  const sprout = drawUntil(state, 'ENEMY', '愿之芽');
  playCard(state, sprout.id);
  const ctx = getContext(state);
  ctx.source = claw;
  ctx.controller = 'PLAYER';
  check(
    'target 条件也能问数量',
    evalCondition(cond({ target: { of: 'ALL_ENEMIES', zone: 'FIELD', count_op: '>=', count_value: 1 } }), ctx.makeScope(claw, 'PLAYER')) === true,
  );
  check(
    'count_value 支持表达式',
    evalCondition(
      cond({ target: { of: 'ALL_ENEMIES', count_op: '>=', count_value: 'COUNT(ALL_ENEMIES)' } }),
      ctx.makeScope(claw, 'PLAYER'),
    ) === true,
  );
}

section('26. 值表达式 + 控制流实战 (推演之环: 循环 / 分支 / 提前收手)');
{
  const state = build(['推演之环'], ['愿之芽', '愿之芽', '愿之芽']);
  const ring = drawUntil(state, 'PLAYER', '推演之环');
  playCard(state, ring.id);
  const foes = [0, 1, 2].map(() => {
    const foe = drawUntil(state, 'ENEMY', '愿之芽');
    playCard(state, foe.id);
    return foe;
  });
  check('敌方三张上齐', cardsInZone(state, 'ENEMY', 'FIELD').length === 3, cardsInZone(state, 'ENEMY', 'FIELD').length);
  check('推演之环攻击力 800 (公式里的 SELF.atk 就是它)', ring.current.atk === 800, ring.current.atk);

  const enemy_hp = state.players.ENEMY.hp;
  check('发动成功', activate(state, ring.id, 'sweep') === true);
  check('「当前攻击力 ×2」= 1600, 前两张被打倒', foes[0].zone === 'GRAVEYARD' && foes[1].zone === 'GRAVEYARD', {
    a: foes[0].zone,
    b: foes[1].zone,
  });
  check(
    '打倒两张后提前收手, 第三张一点没掉',
    foes[2].zone === 'FIELD' && foes[2].current.hp === 800 && foes[2].current.shield === 100,
    { zone: foes[2].zone, hp: foes[2].current.hp, shield: foes[2].current.shield },
  );
  // 8000 - 400 (每倒下一张额外 200) - 700 (两张各溢出 700, 按 50% 传伤) = 6900
  check(
    '每倒下一张额外打击对手 200, 叠加溢出传伤 700 (8000 → 6900)',
    state.players.ENEMY.hp === enemy_hp - 1100,
    state.players.ENEMY.hp,
  );
  check('每回合只能发动 1 次', activate(state, ring.id, 'sweep') === false);
}

section('27. 机读区校验: 新语法的写法错误在保存卡牌时就被挡住');
{
  const err = (raw: unknown) => parseMachineEffect(raw).error;

  check(
    '老写法 (常量数值) 依然合法',
    err({ effects: [{ on: 'TURN_END', operations: [{ type: 'DAMAGE', value: 100 }] }] }) === null,
    err({ effects: [{ on: 'TURN_END', operations: [{ type: 'DAMAGE', value: 100 }] }] }),
  );
  check(
    '新写法 (公式 + 循环 + 变量) 合法',
    err({
      effects: [
        {
          operations: [
            { type: 'SET_VAR', var: 'n', value: 0 },
            {
              type: 'FOR_EACH',
              target: 'ALL_ENEMIES',
              operations: [
                { type: 'DAMAGE', target: 'LOOP_ITEM', value: 'SELF.atk / 2' },
                { type: 'ADD_VAR', var: 'n', value: { agg: 'COUNT', of: 'ALL_ENEMIES' } },
              ],
              break_if: { var: 'n', op: '>=', value: 2 },
            },
          ],
        },
      ],
    }) === null,
    err({
      effects: [
        {
          operations: [
            { type: 'SET_VAR', var: 'n', value: 0 },
            {
              type: 'FOR_EACH',
              target: 'ALL_ENEMIES',
              operations: [
                { type: 'DAMAGE', target: 'LOOP_ITEM', value: 'SELF.atk / 2' },
                { type: 'ADD_VAR', var: 'n', value: { agg: 'COUNT', of: 'ALL_ENEMIES' } },
              ],
              break_if: { var: 'n', op: '>=', value: 2 },
            },
          ],
        },
      ],
    }),
  );

  check('写错的字符串公式会被挡住', Boolean(err({ effects: [{ operations: [{ type: 'DAMAGE', value: 'SELF.atk /' }] }] })));
  check('不认识的表达式键会被挡住', Boolean(err({ effects: [{ operations: [{ type: 'DAMAGE', value: { nope: 1 } }] }] })));
  check('不认识的运算名会被挡住', Boolean(err({ effects: [{ operations: [{ type: 'DAMAGE', value: { op: 'FOO', args: [1, 2] } }] }] })));
  check('不认识的数值字段会被挡住', Boolean(err({ effects: [{ operations: [{ type: 'DAMAGE', value: 'SELF.luck' }] }] })));
  check('不认识的操作名会被挡住', Boolean(err({ effects: [{ operations: [{ type: 'NOPE' }] }] })));
  check('FOR_EACH 缺 operations 会被挡住', Boolean(err({ effects: [{ operations: [{ type: 'FOR_EACH', target: 'ALL_ENEMIES' }] }] })));
  check('IF 缺 condition 会被挡住', Boolean(err({ effects: [{ operations: [{ type: 'IF', then: [] }] }] })));
  check('REPEAT 缺 times 会被挡住', Boolean(err({ effects: [{ operations: [{ type: 'REPEAT', operations: [] }] }] })));
  check('SET_VAR 缺 var 会被挡住', Boolean(err({ effects: [{ operations: [{ type: 'SET_VAR', value: 1 }] }] })));
  check('表达式对象写多了键会被挡住', Boolean(err({ effects: [{ operations: [{ type: 'DAMAGE', value: { stat: 'atk', of: 'SELF', extra: 1 } }] }] })));
  check(
    'scope 只能是 EFFECT / BATTLE',
    Boolean(err({ effects: [{ operations: [{ type: 'SET_VAR', var: 'x', value: 1, scope: 'GLOBAL' }] }] })),
  );
}

section('28. 判定用「加成后的数值」 (绝路之誓: 阈值跟着生命上限走)');
{
  const state = build(['绝路之誓'], ['愿之芽']);
  const oath = toHand(state, 'PLAYER', '绝路之誓');
  playCard(state, oath.id);
  const ctx = getContext(state);
  ctx.source = oath;
  ctx.controller = 'PLAYER';

  check('满血时加成不生效, 攻击力就是卡面的 300', oath.current.atk === 300, oath.current.atk);

  ctx.damage(oath.id, 600, null);
  check('掉到 400 (四成) 还没到三成, 依然不生效', oath.current.atk === 300, oath.current.atk);

  ctx.damage(oath.id, 100, null);
  check(
    '掉到 300 ≤ 上限 ×0.3, 池值一变就立刻 +400 (不用等回合结算)',
    oath.current.atk === 700,
    { hp: oath.current.hp, atk: oath.current.atk },
  );

  // 上限被削弱 → 阈值跟着收紧, 加成消失
  runOperations(ctx, ops([{ type: 'MODIFY', target: 'SELF', stat: 'hp_max', value: -200 }]));
  check(
    '上限削到 800, 阈值变成 240, 300 已经不低于它 → 加成消失',
    oath.current.hp_max === 800 && oath.current.atk === 300,
    { hp_max: oath.current.hp_max, atk: oath.current.atk },
  );

  // 上限被加成 → 阈值跟着放宽, 加成回来 (生命池不会被顺手加血)
  runOperations(ctx, ops([{ type: 'MODIFY', target: 'SELF', stat: 'hp_max', value: 1200 }]));
  check(
    '上限加到 2000, 阈值变成 600 → 加成回来 (但生命还是 300, 加成不等于回血)',
    oath.current.hp_max === 2000 && oath.current.hp === 300 && oath.current.atk === 700,
    { hp_max: oath.current.hp_max, hp: oath.current.hp, atk: oath.current.atk },
  );
}

section('29. 环路保护 (互相引用的修正不会卡死, 结果确定)');
{
  // 条件看自己的攻击力 → 一加就超过阈值, 条件又不成立, 于是来回摆动
  const 自噬 = createCardProvider([
    {
      id: 'loop',
      name: '自噬之环',
      atk: '300',
      shield: '0',
      hp: '1000',
      machine_effect: {
        modifiers: [{ stat: 'atk', value: 400, condition: { self: { stat: 'atk', op: '<', value: 500 } } }],
      },
    },
  ]);
  check('自我引用的条件写得出来, 校验也不拦 (拦不住, 只能靠轮数收手)', Object.keys(自噬.errors).length === 0, 自噬.errors);

  const run = (): number => {
    const state = build(['自噬之环'], [], { provider: 自噬.provider });
    const card = toHand(state, 'PLAYER', '自噬之环');
    playCard(state, card.id);
    return card.current.atk;
  };
  const first = run();
  const second = run();
  check('摆动不死循环, 跑到轮数上限就收手 (取最后一轮的结果)', first === 300 || first === 700, first);
  check('同一份数据两次结果一模一样 (确定, 不是停在哪算哪)', first === second, { first, second });
}

section('30. 能量 (上场资源): 曲线 / 支付 / 付不起就上不了场');
{
  const state = build(['火种', '火种'], ['火种', '燎原']);
  const spark = toHand(state, 'PLAYER', '火种');
  const blaze = cardsInZone(state, 'PLAYER', 'HAND').find(card => card.name === '火种' && card.id !== spark.id)!;
  const expensive = toHand(state, 'ENEMY', '燎原');

  check('卡面费用快照到实例上 (火种 1)', cardCost(spark) === 1, cardCost(spark));
  check('第 1 回合能量上限 1, 行动开始时补满', state.players.PLAYER.energy === 1 && state.players.PLAYER.energy_max === 1, {
    energy: state.players.PLAYER.energy,
    max: state.players.PLAYER.energy_max,
  });
  check('4 费的卡付不起 → canPlayCard 为假', canPlayCard(state, expensive.id) === false && canPayEnergy(state, expensive) === false);
  check('1 费的卡付得起 → 能上场', canPlayCard(state, spark.id) === true);

  check('上场成功并扣掉 1 点能量', playCard(state, spark.id) === true && state.players.PLAYER.energy === 0, state.players.PLAYER.energy);
  check('日志里记下了支付', state.log.some(entry => entry.message.includes('支付 1 点能量')));
  check('能量见底后第二张 1 费卡也上不了场', canPlayCard(state, blaze.id) === false);

  endSide(state, 'PLAYER');
  endSide(state, 'ENEMY');
  check(
    '推进到第 2 回合: 上限涨到 2 并补满 (不是只补 1 点)',
    state.turn === 2 && state.players.PLAYER.energy_max === 2 && state.players.PLAYER.energy === 2,
    { turn: state.turn, energy: state.players.PLAYER.energy, max: state.players.PLAYER.energy_max },
  );
  check('2 费还是不够 4 费', canPlayCard(state, expensive.id) === false);

  // 自定义曲线: 直接给 4 点, 不增长, 封顶 4
  const rich = build(['燎原'], [], { energy: { start: 4, per_turn: 0, cap: 4 } });
  const big = toHand(rich, 'PLAYER', '燎原');
  check('自定义曲线 (起始 4) 下 4 费的卡能上场', canPlayCard(rich, big.id) === true && rich.players.PLAYER.energy === 4);
  playCard(rich, big.id);
  check('付完之后剩 0', rich.players.PLAYER.energy === 0, rich.players.PLAYER.energy);

  const capped = build(['火种'], [], { energy: { start: 1, per_turn: 1, cap: 3 } });
  check('曲线封顶: 第 5 回合也只给 3 点', energyMaxFor(capped, 5) === 3, energyMaxFor(capped, 5));

  const free = build(['燎原'], [], { energy: { enabled: false } });
  const anything = toHand(free, 'PLAYER', '燎原');
  check('关掉能量后两侧都是 0', free.players.PLAYER.energy_max === 0 && free.players.PLAYER.energy === 0);
  check('关掉能量后 4 费的卡也不再受限制', canPlayCard(free, anything.id) === true);
  playCard(free, anything.id);
  check('关掉能量后不扣费也不报错', free.players.PLAYER.energy === 0 && anything.zone === 'FIELD');
}
{
  // 打到一半换一份能量配置 (演习模式的「上场消耗能量」开关就是这么干的):
  // 换完必须把两边重算一遍, 否则卡面还挂着一个用不掉的数字
  const state = build(['火种', '燎原'], [], { energy: { start: 1, per_turn: 0, cap: 1 } });
  const big = toHand(state, 'PLAYER', '燎原');
  check('开局 1 点能量, 4 费的卡上不了场', state.players.PLAYER.energy === 1 && canPlayCard(state, big.id) === false);

  attachBattleConfig(state, { ...battleConfig(state)!, energy: { enabled: false } });
  syncPlayerEnergy(state, 'PLAYER');
  syncPlayerEnergy(state, 'ENEMY');
  check(
    '中途关掉能量: 两边上限与余额都归零, 4 费的卡立刻能上场',
    state.players.PLAYER.energy_max === 0 &&
      state.players.PLAYER.energy === 0 &&
      state.players.ENEMY.energy_max === 0 &&
      canPlayCard(state, big.id) === true,
    { player: state.players.PLAYER.energy, enemy_max: state.players.ENEMY.energy_max },
  );

  attachBattleConfig(state, { ...battleConfig(state)!, energy: { start: 5, per_turn: 0, cap: 5 } });
  syncPlayerEnergy(state, 'PLAYER');
  check(
    '中途再开回来: 按新曲线补满 (不是停在 0)',
    state.players.PLAYER.energy_max === 5 && state.players.PLAYER.energy === 5,
    { energy: state.players.PLAYER.energy, max: state.players.PLAYER.energy_max },
  );

  attachBattleConfig(state, { ...battleConfig(state)!, energy: { start: 2, per_turn: 0, cap: 2, refill: false } });
  syncPlayerEnergy(state, 'PLAYER');
  check(
    '上限调小 (且不补满) 时余额被压到新上限, 不会超发',
    state.players.PLAYER.energy_max === 2 && state.players.PLAYER.energy === 2,
    { energy: state.players.PLAYER.energy, max: state.players.PLAYER.energy_max },
  );
}

section('31. 手牌上限与弃牌询问 (超上限 → 引擎提问 → 面板/AI 回答)');
{
  const state = build(['愿之芽', '愿之芽', '愿之芽', '愿之芽'], [], { hand_limit: 2 });
  drawCards(state, 'PLAYER', 2);
  check('正好到上限: 还没有询问', listAsks(state, 'PLAYER').length === 0);

  drawCards(state, 'PLAYER', 1);
  const asks = listAsks(state, 'PLAYER');
  check('超上限 1 张 → 挂一条弃牌询问', asks.length === 1 && asks[0].kind === 'DISCARD' && asks[0].min === 1, asks);
  const ask = asks[0];
  check('选项就是当前手牌 (3 张)', ask.options.length === 3, ask.options.map(item => item.label));
  check('不回答会自动弃哪张已经算好并写进询问里', ask.fallback.length === 1, ask.fallback);
  check('回答数量不对 → 拒绝', resolveAsk(state, ask.id, []) === false);
  check('选了不在手牌里的卡 → 拒绝', resolveAsk(state, ask.id, ['整条不存在的 id']) === false);

  const victim = cardsInZone(state, 'PLAYER', 'HAND')[1];
  check(
    '回答之后: 那张卡进墓地, 询问消失',
    resolveAsk(state, ask.id, [victim.id]) === true &&
      victim.zone === 'GRAVEYARD' &&
      listAsks(state, 'PLAYER').length === 0,
    { zone: victim.zone, asks: listAsks(state, 'PLAYER').length },
  );
  check('弃牌也会写日志', state.log.some(entry => entry.message.includes('弃掉了')));
}
{
  // 玩家直接把牌打出去也算「解决」: 手牌回到上限以内, 询问自动撤销
  const state = build(['火种', '火种', '火种', '火种'], [], { hand_limit: 2 });
  drawCards(state, 'PLAYER', 3);
  check('超上限就提问', listAsks(state, 'PLAYER').length === 1);
  const card = cardsInZone(state, 'PLAYER', 'HAND')[0];
  playCard(state, card.id);
  check('打出去一张后回到上限以内 → 询问自动撤销', listAsks(state, 'PLAYER').length === 0, listAsks(state, 'PLAYER'));
}
{
  // 没人回答: 换边前按默认答案收尾 (不能把待回答的询问带过换边)
  const state = build(['火种', '火种', '火种', '火种'], [], { hand_limit: 2 });
  drawCards(state, 'PLAYER', 3);
  const ask = listAsks(state, 'PLAYER')[0];
  const planned = ask.fallback.slice();
  endSide(state, 'PLAYER');
  check(
    '换边前没人回答 → 按默认弃牌结算 (弃最便宜的)',
    listAsks(state, 'PLAYER').length === 0 && planned.every(id => state.cards[id]?.zone === 'GRAVEYARD'),
    planned.map(id => state.cards[id]?.zone),
  );
  check('自动结算后手牌回到上限以内', cardsInZone(state, 'PLAYER', 'HAND').length === 2, cardsInZone(state, 'PLAYER', 'HAND').length);
}
{
  // 开局手牌本身就超过上限
  const state = build(['愿之芽', '愿之芽', '愿之芽'], [], { opening_hand: 3, hand_limit: 1 });
  check(
    '开局手牌就超过上限 → 开战时就提问',
    listAsks(state, 'PLAYER').length === 1 && listAsks(state, 'PLAYER')[0].min === 2,
    listAsks(state, 'PLAYER').map(item => item.min),
  );
  const auto = listAsks(state, 'PLAYER')[0];
  check('自动结算 (autoResolveAsk)', autoResolveAsk(state, auto.id) === true && listAsks(state, 'PLAYER').length === 0);
  check('询问没了之后手牌也回到上限', cardsInZone(state, 'PLAYER', 'HAND').length === 1);
}
{
  // 没有手牌上限时永远不提问
  const state = build(['愿之芽', '愿之芽', '愿之芽'], [], { opening_hand: 3 });
  check('不设手牌上限 → 一张都不问', listAsks(state).length === 0);
}

section('32. 机读区 ask: 发动前先问玩家 (答案清单)');
{
  const state = build(['守夜人'], ['燎原'], { energy: { start: 10, per_turn: 0, cap: 10 } });
  const guard = toHand(state, 'PLAYER', '守夜人');
  playCard(state, guard.id);
  // 能量是按「轮到谁」补的, 所以敌方的卡也要等轮到它才能上场
  endSide(state, 'PLAYER');
  const tank = toHand(state, 'ENEMY', '燎原');
  playCard(state, tank.id);
  check('双方都上场了 (能量按行动方补, 不轮到就不能出手)', guard.zone === 'FIELD' && tank.zone === 'FIELD', {
    guard: guard.zone,
    tank: tank.zone,
  });
  endSide(state, 'ENEMY');
  check('回到我方回合, 能量补满', state.turn === 2 && state.players.PLAYER.energy === 10, state.players.PLAYER.energy);

  const askable = listAskable(state, 'PLAYER', ['AFTER_ATTACK']);
  check('攻击前能列出「会问你一句」的效果', askable.length === 1 && askable[0].card_id === guard.id, askable);
  check('没标 ask 的卡不会出现在清单里', listAskable(state, 'ENEMY', ['AFTER_ATTACK']).length === 0);

  // 不带答案清单 = 没人回答 → 按 ask_default (SKIP) 处理
  attack(state, guard.id, tank.id);
  check('没人回答且 ask_default: SKIP → 这条效果不发动', guard.current.atk === 400, guard.current.atk);
  check(
    '日志里留下「这次没有发动」的记录 (提醒玩家场上还有这个技能)',
    state.log.some(entry => entry.message.includes('这次没有发动')),
  );

  endSide(state, 'PLAYER');
  endSide(state, 'ENEMY');
  attack(state, guard.id, tank.id, { answers: [] });
  check('传空清单 = 「问过了, 一个都不发动」', guard.current.atk === 400, guard.current.atk);

  endSide(state, 'PLAYER');
  endSide(state, 'ENEMY');
  const picked = listAskable(state, 'PLAYER', ['AFTER_ATTACK'])[0];
  attack(state, guard.id, tank.id, { answers: [picked.effect_id] });
  check(
    '带上答案清单 → 效果真的发动了 (攻击力 +500, 持续 3 回合)',
    guard.current.atk === 900,
    guard.current.atk,
  );
  check(
    '持续时间会到期 (3 回合后掉回来)',
    Object.values(state.modifiers).some(item => item.target === guard.id && item.expiry?.remaining === 3),
    Object.values(state.modifiers).map(item => ({ target: item.target, value: item.value, remaining: item.expiry?.remaining })),
  );
  check('答案清单不会被留下 (只作用于那一次操作)', getContext(state).answers === null, getContext(state).answers);
}

section('33. 池值变动流水 (pool_events / pool_net)');
{
  const 池 = createCardProvider([
    {
      id: 'pool-core',
      name: '蓄能核',
      atk: '0',
      shield: '300',
      hp: '1000',
      machine_effect: {
        effects: [
          { id: 'mend', on: 'MANUAL', operations: [{ type: 'RESTORE_SHIELD', target: 'SELF', value: 200 }] },
          { id: 'patch', on: 'MANUAL', operations: [{ type: 'HEAL', target: 'SELF', value: 150 }] },
          { id: 'chip', on: 'MANUAL', operations: [{ type: 'DAMAGE', target: 'SELF', value: 120 }] },
          { id: 'spark', on: 'MANUAL', operations: [{ type: 'DAMAGE', target: 'SELF', value: 10, pierce: true }] },
        ],
      },
    },
  ]);
  check('池值测试卡的机读区合法', Object.keys(池.errors).length === 0, 池.errors);

  const state = build(['蓄能核'], [], { provider: 池.provider });
  const core = toHand(state, 'PLAYER', '蓄能核');
  playCard(state, core.id);
  check('刚上场时没有流水', core.pool_events.length === 0 && core.pool_net.hp === 0 && core.pool_net.shield === 0, {
    events: core.pool_events,
    net: core.pool_net,
  });

  activate(state, core.id, 'chip');
  check(
    '护盾被打掉 120 → 一条 shield 流水',
    core.pool_events.length === 1 && core.pool_events[0].stat === 'shield' && core.pool_events[0].delta === -120,
    core.pool_events,
  );
  check(
    '流水记下了回合 / 来源 / 技能名 / 是不是伤害',
    core.pool_events[0].turn === 1 &&
      core.pool_events[0].source === core.id &&
      core.pool_events[0].label === 'chip' &&
      core.pool_events[0].harm === true,
    core.pool_events[0],
  );

  activate(state, core.id, 'mend');
  check('回盾记成正向且不是伤害', core.pool_events[1].delta === 120 && core.pool_events[1].harm === false, core.pool_events[1]);

  activate(state, core.id, 'mend');
  check('加不动的时候不写一条 +0 的流水', core.pool_events.length === 2, core.pool_events.length);

  activate(state, core.id, 'spark');
  activate(state, core.id, 'spark');
  activate(state, core.id, 'spark');
  check(
    '穿盾伤害记在生命上',
    core.pool_events.length === 5 && core.pool_events.slice(-3).every(item => item.stat === 'hp' && item.delta === -10),
    core.pool_events,
  );
  check('池值净变化跟着累', core.pool_net.hp === -30, core.pool_net);

  activate(state, core.id, 'patch');
  check('治疗只记实际加到的量 (970 + 150 只能进 30)', core.pool_events.at(-1)?.delta === 30, core.pool_events.at(-1));
  check('治疗之后生命净变化回到 0', core.pool_net.hp === 0 && core.current.hp === 1000, {
    net: core.pool_net,
    hp: core.current.hp,
  });
  check('护盾净变化为 0', core.pool_net.shield === 0, core.pool_net);

  for (let i = 0; i < 20; i += 1) {
    activate(state, core.id, 'spark');
  }
  check('流水只留最近 POOL_EVENT_LIMIT 条', core.pool_events.length === POOL_EVENT_LIMIT, core.pool_events.length);
  check('留下的是最新的几条', core.pool_events.every(item => item.stat === 'hp' && item.delta === -10), core.pool_events);
  check('流水被截断后净变化依然准确 (20 × -10)', core.pool_net.hp === -200, core.pool_net);
  check('生命值也确实是 1000 - 200', core.current.hp === 800, core.current.hp);

  moveCardTo(state, core.id, 'GRAVEYARD');
  check('离场后流水与净变化都清掉', core.pool_events.length === 0 && core.pool_net.hp === 0 && core.pool_net.shield === 0, {
    events: core.pool_events,
    net: core.pool_net,
  });
}

section('34. 使用次数 (limit) 的用量与用尽时的说明');
{
  const state = build(['研究笔记']);
  const note = drawUntil(state, 'PLAYER', '研究笔记');
  playCard(state, note.id);
  const instance = Object.values(state.effects).find(item => item.def.id === 'study');
  if (!instance) {
    throw new Error('研究笔记的效果没有物化');
  }
  check('还没用过时写明 0/1', describeLimit(effectLimitUsage(state, instance)!) === '本回合 0/1 次', effectLimitUsage(state, instance));

  const 无限 = createCardProvider([
    {
      id: 'free-poke',
      name: '随手点',
      atk: '0',
      shield: '0',
      hp: '500',
      machine_effect: {
        effects: [{ id: 'poke', on: 'MANUAL', operations: [{ type: 'MODIFY', target: 'SELF', stat: 'atk', value: 50 }] }],
      },
    },
  ]);
  const free_state = build(['随手点'], [], { provider: 无限.provider });
  const poke = toHand(free_state, 'PLAYER', '随手点');
  playCard(free_state, poke.id);
  const poke_effect = Object.values(free_state.effects).find(item => item.def.id === 'poke');
  if (!poke_effect) {
    throw new Error('随手点的效果没有物化');
  }
  check('没写 limit 的效果没有用量', effectLimitUsage(free_state, poke_effect) === null, effectLimitUsage(free_state, poke_effect));

  check('第一次发动成功', activate(state, note.id, 'study') === true);
  check('发动后用量 1/1', describeLimit(effectLimitUsage(state, instance)!) === '本回合 1/1 次', effectLimitUsage(state, instance));

  const before = state.log.length;
  check('第二次发动被次数挡住', activate(state, note.id, 'study') === false);
  check(
    '挡下来的时候留下理由 (不再静默失败)',
    state.log.slice(before).some(entry => entry.message.includes('这次没有发动') && entry.message.includes('本回合 1 次已用完')),
    state.log.slice(before).map(entry => entry.message),
  );
  check(
    '用尽的技能不再出现在可发动清单里 (面板拿去发按钮)',
    listActivatable(state, 'PLAYER').every(item => item.def_id !== 'study'),
    listActivatable(state, 'PLAYER'),
  );

  endTurn(state);
  check('回合过去后次数重置', describeLimit(effectLimitUsage(state, instance)!) === '本回合 0/1 次', effectLimitUsage(state, instance));
  check('新回合又能发动', activate(state, note.id, 'study') === true);
}

section('35. 日志与浮字里的技能名 (effectName / effectTitle)');
{
  const state = build(['研究笔记']);
  const note = drawUntil(state, 'PLAYER', '研究笔记');
  playCard(state, note.id);
  const instance = Object.values(state.effects).find(item => item.def.id === 'study');
  if (!instance) {
    throw new Error('研究笔记的效果没有物化');
  }
  const ctx = getContext(state);
  check('写了 id 的效果用 id 当技能名', effectName(ctx, instance) === 'study', effectName(ctx, instance));
  check('标题形如「卡名」的【技能名】', effectTitle(ctx, instance) === '「研究笔记」的【study】', effectTitle(ctx, instance));
  const before = state.log.length;
  activate(state, note.id, 'study');
  check(
    '发动日志写技能名而不是只写角色名',
    state.log.slice(before).some(entry => entry.message === '「研究笔记」的【study】 发动'),
    state.log.slice(before).map(entry => entry.message),
  );
}
{
  const 单效 = createCardProvider([
    {
      id: 'one-effect',
      name: '单效',
      atk: '0',
      shield: '0',
      hp: '500',
      machine_effect: {
        effects: [{ on: 'MANUAL', operations: [{ type: 'MODIFY', target: 'SELF', stat: 'atk', value: 100 }] }],
      },
    },
    {
      id: 'two-effect',
      name: '双效',
      atk: '100',
      shield: '0',
      hp: '1000',
      machine_effect: {
        effects: [
          { id: 'first', on: 'MANUAL', operations: [{ type: 'MODIFY', target: 'SELF', stat: 'atk', value: 100 }] },
          { on: 'MANUAL', operations: [{ type: 'MODIFY', target: 'SELF', stat: 'atk', value: 200 }] },
        ],
      },
    },
  ]);
  check('技能名测试卡的机读区合法', Object.keys(单效.errors).length === 0, 单效.errors);

  const single = build(['单效'], [], { provider: 单效.provider });
  const one = toHand(single, 'PLAYER', '单效');
  playCard(single, one.id);
  const one_effect = single.effects[one.effects[0]];
  check(
    '只有一条效果又没写 id → 不念「效果 1」',
    effectName(getContext(single), one_effect) === null,
    effectName(getContext(single), one_effect),
  );
  check('标题退回卡名本身', effectTitle(getContext(single), one_effect) === '「单效」', effectTitle(getContext(single), one_effect));

  const multi = build(['双效'], [], { provider: 单效.provider });
  const two = toHand(multi, 'PLAYER', '双效');
  playCard(multi, two.id);
  const list = listActivatable(multi, 'PLAYER');
  check('两条效果都能主动发动', list.length === 2, list);
  const second = list.find(item => item.def_id !== 'first');
  if (!second) {
    throw new Error('第二条效果没在可发动清单里');
  }
  check(
    '没写 id 的效果在一张卡有多条时用序号区分',
    effectName(getContext(multi), multi.effects[second.effect_id]) === '效果 2',
    effectName(getContext(multi), multi.effects[second.effect_id]),
  );
  const before_multi = multi.log.length;
  activate(multi, two.id, second.effect_id);
  check(
    '日志用「效果 2」区分是哪一条',
    multi.log.slice(before_multi).some(entry => entry.message === '「双效」的【效果 2】 发动'),
    multi.log.slice(before_multi).map(entry => entry.message),
  );
}

section('36. 战斗规则: 抽牌时机 / 守卫 / 溢出传伤 / 洗牌代价 / 回合上限');
{
  // 搭一场「我方 狂战之魂 打敌方 研究笔记」的局, 三项规则都用得上
  const strike = (options: BuildOptions) => {
    const state = build(['狂战之魂'], ['研究笔记'], options);
    const knight = toHand(state, 'PLAYER', '狂战之魂');
    playCard(state, knight.id);
    const note = toHand(state, 'ENEMY', '研究笔记');
    playCard(state, note.id);
    return { state, knight, note, hp: state.players.ENEMY.hp };
  };

  // ---- 抽牌时机: 每方自己行动开始时抽, 先手方第 1 回合不抽 ----
  const timing = build(['愿之芽', '愿之芽', '愿之芽'], ['愿之芽', '愿之芽', '愿之芽']);
  check(
    '第 1 回合的先手方不抽牌 (先手补偿)',
    timing.turn === 1 && cardsInZone(timing, 'PLAYER', 'HAND').length === 0,
    cardsInZone(timing, 'PLAYER', 'HAND').length,
  );
  endSide(timing, 'PLAYER');
  check(
    '后手方行动一开始就抽 1 张',
    cardsInZone(timing, 'ENEMY', 'HAND').length === 1,
    cardsInZone(timing, 'ENEMY', 'HAND').length,
  );
  endSide(timing, 'ENEMY');
  check(
    '第 2 回合起先手方行动开始也抽 1 张',
    timing.turn === 2 && cardsInZone(timing, 'PLAYER', 'HAND').length === 1,
    { turn: timing.turn, hand: cardsInZone(timing, 'PLAYER', 'HAND').length },
  );
  check(
    '行动开始的日志里写明了抽牌',
    timing.log.some(entry => entry.message.includes('行动开始') && entry.message.includes('抽 1 张')),
    timing.log.map(entry => entry.message).filter(message => message.includes('行动开始')),
  );

  const no_draw = build(['愿之芽', '愿之芽'], ['愿之芽', '愿之芽'], { draw_per_turn: 0 });
  endSide(no_draw, 'PLAYER');
  check(
    'draw_per_turn = 0 退回「只在开局发牌」',
    cardsInZone(no_draw, 'ENEMY', 'HAND').length === 0,
    cardsInZone(no_draw, 'ENEMY', 'HAND').length,
  );

  // ---- 守卫: 对手场上还有卡时打不了脸 ----
  const guarded = strike({});
  check(
    '对手场上有卡时打脸被守卫挡下',
    attack(guarded.state, guarded.knight.id, 'ENEMY') === false && guarded.state.players.ENEMY.hp === guarded.hp,
    guarded.state.players.ENEMY.hp,
  );
  check(
    '挡下时在日志里说明了原因',
    guarded.state.log.some(entry => entry.message.includes('场上还有卡')),
    guarded.state.log.map(entry => entry.message).filter(message => message.includes('打场上的卡')),
  );
  check('被挡下不算出手 (攻击次数还在)', canAttack(guarded.state, guarded.knight.id) === true);
  check('守卫不挡「打场上的卡」', attack(guarded.state, guarded.knight.id, guarded.note.id) === true);

  const unguarded = strike({ guard: false });
  check(
    '关掉守卫就能直接打脸 (700 点)',
    attack(unguarded.state, unguarded.knight.id, 'ENEMY') === true &&
      unguarded.state.players.ENEMY.hp === unguarded.hp - 700,
    unguarded.state.players.ENEMY.hp,
  );

  // ---- 溢出传伤: 打死卡之后多出来的伤害按比例传给卡主 ----
  // 研究笔记 400 生命 / 0 护盾: 700 伤害里 400 打死它, 多的 300 传伤
  const splash = strike({});
  check(
    '溢出 300 按 50% 传给卡主 (150 点)',
    attack(splash.state, splash.knight.id, splash.note.id) === true &&
      splash.state.players.ENEMY.hp === splash.hp - 150,
    splash.state.players.ENEMY.hp,
  );
  check(
    '传伤写进了日志',
    splash.state.log.some(entry => entry.message.includes('溢出伤害')),
    splash.state.log.map(entry => entry.message).filter(message => message.includes('溢出')),
  );

  const no_splash = strike({ splash: 0 });
  check(
    'splash = 0 时一点不传',
    attack(no_splash.state, no_splash.knight.id, no_splash.note.id) === true &&
      no_splash.state.players.ENEMY.hp === no_splash.hp,
    no_splash.state.players.ENEMY.hp,
  );

  const full_splash = strike({ splash: 1 });
  check(
    'splash = 1 时全额传 (300 点)',
    attack(full_splash.state, full_splash.knight.id, full_splash.note.id) === true &&
      full_splash.state.players.ENEMY.hp === full_splash.hp - 300,
    full_splash.state.players.ENEMY.hp,
  );

  // 没打死就不该有传伤 (伤害全部落在卡自己身上)
  const sturdy = build(['狂战之魂'], ['愿之芽'], {});
  const knight4 = toHand(sturdy, 'PLAYER', '狂战之魂');
  playCard(sturdy, knight4.id);
  const sprout4 = toHand(sturdy, 'ENEMY', '愿之芽');
  playCard(sturdy, sprout4.id);
  const sturdy_hp = sturdy.players.ENEMY.hp;
  check(
    '没打死卡时没有溢出伤害',
    attack(sturdy, knight4.id, sprout4.id) === true &&
      sturdy.players.ENEMY.hp === sturdy_hp &&
      sprout4.zone === 'FIELD',
    sturdy.players.ENEMY.hp,
  );

  // ---- 洗牌代价: 加价 + 次数上限 ----
  const recycle = build(['愿之芽'], [], { recycle_penalty: 2, recycle_limit: 1 });
  const sprout = cardsInZone(recycle, 'PLAYER', 'DECK')[0];
  moveCardTo(recycle, sprout.id, 'GRAVEYARD');
  check('洗牌前没有加价', recycleSurcharge(recycle, 'PLAYER') === 0);
  check('牌库抽空时把墓地洗回来并抽到牌', drawCards(recycle, 'PLAYER', 1) === 1);
  check('洗牌次数记到了那一方头上', recycle.players.PLAYER.recycle_count === 1);
  check('每洗一次累积 2 点上场加价', recycleSurcharge(recycle, 'PLAYER') === 2);
  check(
    '上场消耗带上加价 (卡面值不变)',
    cardCost(sprout) === 0 && cardCostFor(recycle, sprout) === 2,
    cardCostFor(recycle, sprout),
  );
  check(
    '洗牌日志写明了次数与加价',
    recycle.log.some(entry => entry.message.includes('1/1 次') && entry.message.includes('累计 +2')),
    recycle.log.map(entry => entry.message).filter(message => message.includes('洗回牌库')),
  );
  moveCardTo(recycle, sprout.id, 'GRAVEYARD');
  check('次数用完后洗不动, 也就抽不到牌', drawCards(recycle, 'PLAYER', 1) === 0);
  check(
    '日志说明了洗牌次数已用完',
    recycle.log.some(entry => entry.message.includes('洗牌次数已用完')),
    recycle.log.map(entry => entry.message).filter(message => message.includes('洗牌')),
  );

  const free_recycle = build(['愿之芽'], [], { recycle_penalty: 0 });
  const sprout_free = cardsInZone(free_recycle, 'PLAYER', 'DECK')[0];
  moveCardTo(free_recycle, sprout_free.id, 'GRAVEYARD');
  check('不加价时也照样能洗回牌库', drawCards(free_recycle, 'PLAYER', 1) === 1);
  check('recycle_penalty = 0 时洗牌不加价', recycleSurcharge(free_recycle, 'PLAYER') === 0);

  // ---- 回合上限: 打满后按剩余生命比例判定 ----
  const limited = build(['愿之芽'], ['愿之芽'], { turn_limit: 2 });
  limited.players.PLAYER.hp = 2000; // 我方只剩 25%, 敌方还是满血
  endTurn(limited);
  check('没打满上限时照常继续', limited.finished === false && limited.turn === 2, limited.turn);
  endTurn(limited);
  check('打满后按剩余生命比例判定: 敌方获胜', limited.finished === true && limited.winner === 'ENEMY', limited.winner);
  check(
    '日志写明判定依据',
    limited.log.some(entry => entry.message.includes('回合上限')),
    limited.log.map(entry => entry.message).filter(message => message.includes('回合上限')),
  );

  const tie = build(['愿之芽'], ['愿之芽'], { turn_limit: 1 });
  endTurn(tie);
  check('比例相同时算平局 (但战斗确实结束)', tie.finished === true && tie.winner === null, tie.winner);

  const endless = build(['愿之芽'], ['愿之芽'], { turn_limit: 0 });
  endTurn(endless);
  check('turn_limit = 0 时不会因为回合数结束', endless.finished === false && endless.turn === 2, endless.turn);
}

// ---------------------------------------------------------------------------

console.log(`\n通过 ${passed} 项, 失败 ${failed} 项`);
if (failed > 0) {
  throw new Error(`有 ${failed} 项测试失败`);
}
