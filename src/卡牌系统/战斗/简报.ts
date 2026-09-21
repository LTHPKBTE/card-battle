// 战斗简报 - 把引擎状态压缩成「AI 需要、且只需要」的那些信息
//
// 纯函数, 不依赖酒馆全局, 可直接在 node 中测试.
// 三条原则:
//   1. 只给 AI 看得见的东西: 自己的手牌/场上、对手的场上、双方生命、最近战况;
//   2. 绝不给对手手牌、双方牌库内容、随机种子等隐藏信息 (避免 AI 依据不可见信息作弊);
//   3. 每张卡都用引擎实例 id (c1 / c2 …) 指代, AI 输出操作时直接引用, 不需要额外映射表.

import { canAttack, canPayEnergy, canPlayCard, cardCost, listActivatable, listAsks } from '../引擎/battle.ts';
import { cardsInZone } from '../引擎/selectors.ts';
import { statSourceLines } from '../引擎/溯源.ts';
import {
  logLevelRank,
  otherPlayer,
  type AskKind,
  type BattleState,
  type CardInstance,
  type PlayerId,
} from '../引擎/types.ts';

/** 简报里的一张卡 */
export interface BriefCard {
  /** 引擎实例 id (c1 / c2 …), AI 操作时用它指代这张卡 */
  id: string;
  name: string;
  atk: number;
  /** 当前护盾池 (被打空就是 0, 之后可以再回复) */
  shield: number;
  /** 护盾上限 (受修正影响后的值) */
  shield_max: number;
  hp: number;
  hp_max: number;
  /** 卡面基础数值 (未受修正影响), 用来算出「变更的量」 */
  base: { atk: number; shield: number; hp: number };
  /** 状态显示名 */
  statuses: string[];
  /** 身上的加成 / 减值来源, 如 `ATK +200 ← 「愿之芽」` */
  bonuses: string[];
  /** 本回合是否已经攻击过 */
  attacked: boolean;
  /** 此刻能否攻击 (已攻击 / 战斗结束时为 false) */
  can_attack: boolean;
  /** 此刻能否上场 (只有手牌有意义) */
  playable: boolean;
  /** 上场要消耗的能量 (卡牌实例上的快照, 0 = 免费) */
  energy: number;
  /** 不能上场的原因 (空串 = 能上场); 只有手牌有意义 */
  play_block: string;
}

/** 简报里一条要 AI 回答的询问 (引擎挂出来的) */
export interface BriefAsk {
  /** 回答时填在 `ask` 字段的值 */
  id: string;
  kind: AskKind;
  title: string;
  /** 面向玩家的说明 (例如「不选的话引擎会自己弃掉 X」) */
  detail: string;
  /** 至少要选几张 */
  min: number;
  /** 最多能选几张 */
  max: number;
  /** 可选答案 (弃牌类询问里 `card` 就是手牌实例 id) */
  options: { id: string; label: string; card: string | null }[];
}

/** 简报里可主动发动的效果 */
export interface BriefEffect {
  /** 来源卡实例 id */
  card: string;
  /** 发动时填在 `effect` 字段的值 */
  effect: string;
  /** 显示名, 如「狂战之魂 · 战意」 */
  label: string;
}

/** 简报里一条持续状态 (已有效果) */
export interface BriefStatus {
  /** 目标名 (卡名, 或卡实例 id) */
  target: string;
  /** 状态名 */
  name: string;
  /** 叠加层数 */
  stacks: number;
  /** 剩余回合数; null 表示永续 */
  remaining: number | null;
  /** 施加者卡名; 溯不到时为 null */
  source: string | null;
}

/** 结构化简报 (面板也可以直接用它渲染) */
export interface BattleBrief {
  turn: number;
  /** 行动方 */
  active: PlayerId;
  /** AI 控制的阵营 */
  ai: PlayerId;
  /** AI 的对手 */
  opponent: PlayerId;
  ai_hp: number;
  ai_hp_max: number;
  opponent_hp: number;
  opponent_hp_max: number;
  /** AI 剩余能量 / 上限 (关掉能量机制时都是 0) */
  ai_energy: number;
  ai_energy_max: number;
  opponent_energy: number;
  opponent_energy_max: number;
  /** 轮到 AI 回答的询问 (不回答引擎会自己收尾, 但会亏) */
  asks: BriefAsk[];
  /** AI 场上 */
  ai_field: BriefCard[];
  /** 对手场上 */
  opponent_field: BriefCard[];
  /** AI 手牌 */
  ai_hand: BriefCard[];
  /** AI 手牌里此刻能上场的卡实例 id */
  playable: string[];
  /** AI 此刻能主动发动的效果 */
  activatable: BriefEffect[];
  /** 双方场上当前的持续状态 (已有效果) */
  statuses: BriefStatus[];
  /** 本回合与上一回合双方已经做过的操作 (旧 → 新) */
  player_ops: string[];
  /** 最近战况 (旧 → 新, 已剔除过于琐碎的 EVENT 记录) */
  recent: string[];
  finished: boolean;
  winner: PlayerId | null;
}

/** 简报里最多保留多少条最近战况 */
export const BRIEF_RECENT_LIMIT = 10;

/**
 * 会泄露隐藏信息的日志 (抽牌会把对手刚抽到的卡名写出来).
 *
 * 双方手牌在简报里本来就只列 AI 自己的, 所以这类行一律剔除.
 */
function isPrivateLog(message: string): boolean {
  return message.includes('进入手牌');
}

/** 手牌不能上场时该说清到底是哪一条卡住了 */
function playBlockReason(state: BattleState, card: CardInstance): string {
  if (canPlayCard(state, card.id)) {
    return '';
  }
  if (!canPayEnergy(state, card)) {
    return `能量不足(需 ${cardCost(card)}, 只剩 ${state.players[card.controller].energy})`;
  }
  if (card.zone !== 'HAND') {
    return '不在手牌';
  }
  return '场上已满';
}

function toBriefCard(state: BattleState, card: CardInstance): BriefCard {
  return {
    id: card.id,
    name: card.name,
    atk: card.current.atk,
    shield: card.current.shield,
    shield_max: card.current.shield_max,
    hp: card.current.hp,
    hp_max: card.current.hp_max,
    base: { ...card.base },
    statuses: card.statuses.map(id => state.statuses[id]?.name || id),
    bonuses: statSourceLines(state, card),
    attacked: card.attacked_this_turn,
    can_attack: canAttack(state, card.id),
    playable: canPlayCard(state, card.id),
    energy: cardCost(card),
    play_block: playBlockReason(state, card),
  };
}

/** 收集双方场上当前的持续状态 */
function buildStatuses(state: BattleState): BriefStatus[] {
  return Object.values(state.statuses).map(status => ({
    target: state.cards[status.target]?.name ?? status.target,
    name: status.name,
    stacks: status.stacks,
    remaining: status.expiry ? status.expiry.remaining : null,
    source: status.source ? (state.cards[status.source]?.name ?? null) : null,
  }));
}

/** 生成结构化简报 */
export function buildBrief(state: BattleState, ai: PlayerId = 'ENEMY', player_ops: string[] = []): BattleBrief {
  const opponent = otherPlayer(ai);
  const ai_player = state.players[ai];
  const opponent_player = state.players[opponent];

  const ai_hand = cardsInZone(state, ai, 'HAND').map(card => toBriefCard(state, card));

  return {
    turn: state.turn,
    active: state.active,
    ai,
    opponent,
    ai_hp: ai_player.hp,
    ai_hp_max: ai_player.hp_max,
    opponent_hp: opponent_player.hp,
    opponent_hp_max: opponent_player.hp_max,
    ai_energy: ai_player.energy,
    ai_energy_max: ai_player.energy_max,
    opponent_energy: opponent_player.energy,
    opponent_energy_max: opponent_player.energy_max,
    asks: listAsks(state, ai).map(ask => ({
      id: ask.id,
      kind: ask.kind,
      title: ask.title,
      detail: ask.detail,
      min: ask.min,
      max: ask.max,
      options: ask.options.map(option => ({ id: option.id, label: option.label, card: option.card })),
    })),
    ai_field: cardsInZone(state, ai, 'FIELD').map(card => toBriefCard(state, card)),
    opponent_field: cardsInZone(state, opponent, 'FIELD').map(card => toBriefCard(state, card)),
    ai_hand,
    playable: ai_hand.filter(card => card.playable).map(card => card.id),
    activatable: listActivatable(state, ai).map(item => ({
      card: item.card_id,
      effect: item.def_id || item.effect_id,
      label: item.label,
    })),
    statuses: buildStatuses(state),
    player_ops: player_ops.slice(-BRIEF_RECENT_LIMIT),
    // 事件流水 (DEBUG) 太琐碎、引擎内部问题 (卡牌库缺卡等) AI 也修不了, 都不进简报
    recent: state.log
      .filter(
        entry =>
          !entry.engine_only && logLevelRank(entry.level) >= logLevelRank('INFO') && !isPrivateLog(entry.message),
      )
      .slice(-BRIEF_RECENT_LIMIT)
      .map(entry => `T${entry.turn} ${entry.message}`),
    finished: state.finished,
    winner: state.winner,
  };
}

/** 双方阵营的显示名 (以 AI 视角称呼) */
function sideLabel(brief: BattleBrief, player: PlayerId): string {
  return player === brief.ai ? `你(${brief.ai})` : `对手(${brief.opponent})`;
}

function renderCard(card: BriefCard, hand = false): string {
  // 与卡面基础值不同时附上变化量, 让 AI 知道「这一局已经改过什么」
  const stat = (value: number, base: number) =>
    value === base ? `${value}` : `${value}(${value > base ? '+' : ''}${value - base})`;
  const shield =
    card.shield === card.shield_max
      ? stat(card.shield, card.base.shield)
      : `${card.shield}/${stat(card.shield_max, card.base.shield)}`;
  const hp =
    card.hp === card.hp_max
      ? stat(card.hp, card.base.hp)
      : `${card.hp}/${stat(card.hp_max, card.base.hp)}`;
  const marks: string[] = [];
  if (hand) {
    marks.push(card.playable ? '可上场' : card.play_block || '不能上场');
  } else if (card.attacked) {
    marks.push('已攻击');
  } else if (card.can_attack) {
    marks.push('可攻击');
  }
  if (card.statuses.length > 0) {
    marks.push(card.statuses.join('/'));
  }
  const tail = marks.length > 0 ? ` [${marks.join(' ')}]` : '';
  // 数值顺序固定为 攻击/护盾/生命, 与协议里的说明对应
  const stats = `${stat(card.atk, card.base.atk)}/${shield}/${hp}`;
  // 手牌上标出上场要花的能量 (场上卡已经付过了, 不用重复标)
  const price = hand && card.energy > 0 ? `${card.energy}费 ` : '';
  // 有加成 / 减值时把来源一并写出来, 让 AI 知道「为什么这个数不是卡面值」
  const bonus = card.bonuses.length > 0 ? ` {${card.bonuses.join(' , ')}}` : '';
  return `${card.id} ${card.name} ${price}${stats}${tail}${bonus}`;
}

function renderCards(cards: BriefCard[], hand = false): string {
  return cards.length > 0 ? cards.map(card => renderCard(card, hand)).join(' | ') : '(空)';
}

/** * 防止内容里的花括号被酒馆当成宏再展开一次.
 *
 * 简报会被世界书条目用 {{format_chat_variable::}} 读走, 而该宏的替换结果会继续参与宏展开.
 */
export function sanitizeForPrompt(text: string): string {
  return text.replaceAll('{{', '{ {').replaceAll('}}', '} }');
}

function renderStatus(status: BriefStatus): string {
  const stacks = status.stacks > 1 ? `×${status.stacks}` : '';
  const remain = status.remaining === null ? '' : ` (${status.remaining}T)`;
  const from = status.source ? ` ←「${status.source}」` : '';
  return `${status.target} ${status.name}${stacks}${remain}${from}`;
}

/** * 渲染成注入提示词的紧凑文本.
 *
 * 只有 `行动方` 是 AI 时才会被调用 (由 同步.ts 决定), 所以这里不需要再判断。
 */
export function renderBrief(brief: BattleBrief): string {
  const lines: string[] = [];
  // 行动方是「半个回合」: 一个回合里双方各行动一次, 双方都收手后进入回合结算
  lines.push(`回合 ${brief.turn} · 当前行动方 ${sideLabel(brief, brief.active)} (双方各行动一次后结算回合)`);
  lines.push(`${sideLabel(brief, brief.ai)} HP ${brief.ai_hp}/${brief.ai_hp_max}`);
  lines.push(`${sideLabel(brief, brief.opponent)} HP ${brief.opponent_hp}/${brief.opponent_hp_max}`);
  // 上限为 0 表示这场战斗没开能量机制, 就不占提示词的位置了
  if (brief.ai_energy_max > 0 || brief.opponent_energy_max > 0) {
    lines.push(`${sideLabel(brief, brief.ai)} 能量 ${brief.ai_energy}/${brief.ai_energy_max}`);
    lines.push(`${sideLabel(brief, brief.opponent)} 能量 ${brief.opponent_energy}/${brief.opponent_energy_max}`);
  }
  lines.push(`你的场上: ${renderCards(brief.ai_field)}`);
  lines.push(`对手场上: ${renderCards(brief.opponent_field)}`);
  lines.push(`你的手牌: ${renderCards(brief.ai_hand, true)}`);
  if (brief.activatable.length > 0) {
    lines.push(
      `可发动: ${brief.activatable.map(item => `${item.card}#${item.effect} ${item.label}`).join(' | ')}`,
    );
  }
  if (brief.statuses.length > 0) {
    lines.push(`已有效果: ${brief.statuses.map(renderStatus).join(' | ')}`);
  }
  if (brief.asks.length > 0) {
    lines.push('需要你回答:');
    for (const ask of brief.asks) {
      const options = ask.options.map(option => `${option.label}[${option.card ?? option.id}]`).join(' | ');
      lines.push(`- ${ask.title} (选 ${ask.min}-${ask.max} 张) ${ask.detail}`);
      lines.push(`  可选: ${options}`);
      lines.push(`  回答方式: {"do":"answer","ask":"${ask.id}","cards":["这里填卡实例 id"]}`);
    }
  }
  if (brief.player_ops.length > 0) {
    lines.push('最近操作:');
    for (const line of brief.player_ops) {
      lines.push(`- ${line}`);
    }
  }
  if (brief.recent.length > 0) {
    lines.push('最近战况:');
    for (const line of brief.recent) {
      lines.push(`- ${line}`);
    }
  }
  if (brief.finished) {
    lines.push(brief.winner ? `战斗已结束: ${brief.winner} 获胜` : '战斗已结束: 平局');
  }
  return sanitizeForPrompt(lines.join('\n'));
}

/** 从引擎状态直接生成简报文本 */
export function briefText(state: BattleState, ai: PlayerId = 'ENEMY', player_ops: string[] = []): string {
  return renderBrief(buildBrief(state, ai, player_ops));
}
