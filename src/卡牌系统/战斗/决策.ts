// 战斗决策 - 从 AI 回复中提取结构化操作, 校验后应用到引擎
//
// 纯函数, 不依赖酒馆全局, 可直接在 node 中测试.
//
// AI 的输出约定 (与 协议.ts 的提示词严格对应, 改动时必须同步):
//   <battle_action>{"回合":3,"操作":[{"do":"play","card":"c9"}, ...]}</battle_action>
//
// 需要「先问一句」的技能 (机读区标了 ask): 由 AI 自己在操作里写 `answers` 批准,
// 例如 {"do":"attack","card":"c9","target":"E2","answers":["e12"]}; 没写就按卡上的 ask_default 处理.
// 收手时 (SIDE_END / TURN_END) 触发的技能写在最外层: {"answers":["e12"],"操作":[...]}.
// 手牌超上限要弃牌时用 {"do":"discard","cards":["c3"]} (不写 ask id 就回答当前那条询问).
//
// 校验策略是「整块接受 / 逐条跳过」:
//   - 整块拒绝: 战斗已结束、不是 AI 的回合、回合数对不上、结构不合法、操作数超上限;
//   - 逐条跳过: 单条操作不合法 (卡不在手里、已攻击过、目标不存在…) 只跳过它, 不影响后续,
//     并且每次都按「当前最新局面」重新判定, 所以前一条操作改变了局面也不会误判。

import {
  activate,
  attack,
  canAttack,
  canMoveCardTo,
  canPayEnergy,
  canPlayCard,
  cardCost,
  endSide,
  listAsks,
  moveCardTo,
  playCard,
  resolveAsk,
} from '../引擎/battle.ts';
import { isPlayerTarget, type BattleState, type PlayerId } from '../引擎/types.ts';

/** 决策块的标签名 (开闭标签都是它) */
export const ACTION_TAG = 'battle_action';

/** 一次决策最多允许的操作数 */
export const MAX_DECISION_OPS = 8;

/** 「结束行动」这条操作的说明文字 (调用方据此判断要不要换边) */
export const END_TURN_DETAIL = '结束行动';

/** 提取结果 */
export interface DecisionExtract {
  /** 是否成功解析出一个决策 */
  ok: boolean;
  /** 捕获到的决策块原文 (含标签) */
  raw: string;
  /** 从原文中剔除所有决策块后的文本 (可继续作为叙事正文使用) */
  cleaned: string;
  /** 解析出的 JSON 值 */
  value: unknown;
  /** 规范化后的操作列表; 解析失败为 null */
  ops: unknown[] | null;
  /** 决策块里声明的回合数; 没写为 null */
  turn: number | null;
  /** 失败原因 */
  error: string;
}

/** 单条操作的处理结果 */
export interface DecisionOpResult {
  /** 人类可读的操作描述 */
  detail: string;
  /** 是否执行成功 */
  applied: boolean;
}

/** 整块决策的应用结果 */
export interface DecisionResult {
  /** 整块是否被接受 */
  ok: boolean;
  /** 整块被拒绝的原因 (ok 为 true 时为空) */
  error: string;
  /** 成功执行的操作描述 */
  applied: string[];
  /** 被跳过的操作描述 (含原因) */
  ignored: string[];
  /** 是否结束了回合 (正常执行完都会结束) */
  ended: boolean;
  /** 应用后的战斗是否已结束 */
  finished: boolean;
  /** 胜者 */
  winner: PlayerId | null;
  /** 本次新增的战斗日志 */
  log: string[];
}

function blockRegex(): RegExp {
  return new RegExp(`<${ACTION_TAG}\\b[^>]*>([\\s\\S]*?)</${ACTION_TAG}>`, 'gi');
}

/** 去掉模型习惯性包上的 ```json 围栏 */
function stripFence(text: string): string {
  return text
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
}

/** 尝试把文本解析成 JSON, 容忍前后夹杂的说明文字 */
function parseLoose(text: string): { value: unknown; error: string } {
  const body = stripFence(text);
  if (!body) {
    return { value: null, error: '决策块是空的' };
  }
  try {
    return { value: JSON.parse(body), error: '' };
  } catch {
    // 模型可能在 JSON 前后夹了说明, 退一步取最外层的 { } 或 [ ]
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return { value: JSON.parse(body.slice(start, end + 1)), error: '' };
      } catch (error) {
        return { value: null, error: `决策 JSON 解析失败: ${String(error)}` };
      }
    }
    return { value: null, error: '决策 JSON 解析失败: 括号不完整' };
  }
}

/** 规范化决策: 允许裸数组, 或 { 操作 | actions | ops } */
function normalize(value: unknown): { ops: unknown[] | null; turn: number | null; error: string } {
  if (Array.isArray(value)) {
    return { ops: value, turn: null, error: '' };
  }
  if (!value || typeof value !== 'object') {
    return { ops: null, turn: null, error: '决策必须是对象或数组' };
  }
  const record = value as Record<string, unknown>;
  const raw_ops = record.操作 ?? record.actions ?? record.ops;
  if (!Array.isArray(raw_ops)) {
    return { ops: null, turn: null, error: '决策里缺少 操作 数组' };
  }
  const raw_turn = record.回合 ?? record.turn;
  const turn = typeof raw_turn === 'number' && Number.isFinite(raw_turn) ? raw_turn : null;
  return { ops: raw_ops, turn, error: '' };
}

/**
 * 从 AI 回复里提取决策块.
 *
 * 一条消息里出现多个决策块时取**最后一个** (模型重写时常见), 同时把所有块都从 `cleaned` 里剔除.
 */
export function extractDecision(text: unknown): DecisionExtract {
  const source = String(text ?? '');
  const matches = [...source.matchAll(blockRegex())];
  const cleaned = source.replace(blockRegex(), '').replace(/\n{3,}/g, '\n\n').trim();

  if (matches.length === 0) {
    return {
      ok: false,
      raw: '',
      cleaned,
      value: null,
      ops: null,
      turn: null,
      error: '没有找到决策块',
    };
  }

  const last = matches[matches.length - 1];
  const raw = last[0];
  const { value, error: parse_error } = parseLoose(last[1] ?? '');
  if (parse_error) {
    return { ok: false, raw, cleaned, value: null, ops: null, turn: null, error: parse_error };
  }

  const { ops, turn, error: shape_error } = normalize(value);
  if (shape_error) {
    return { ok: false, raw, cleaned, value, ops: null, turn: null, error: shape_error };
  }

  return { ok: true, raw, cleaned, value, ops, turn, error: '' };
}

/** 取字段 (兼容中英文键名) */
function pick(op: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (op[key] !== undefined && op[key] !== null) {
      return op[key];
    }
  }
  return undefined;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** 卡牌显示名 (找不到就退回 id) */
function cardName(state: BattleState, id: string): string {
  return state.cards[id]?.name ?? id;
}

/** 可选的上场位置 (写了才用, 没写就让引擎自己找空位) */
function pickSlot(record: Record<string, unknown>): number | undefined {
  const raw = pick(record, ['slot', '位置']);
  const slot = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(slot) && slot >= 0 ? slot : undefined;
}

/**
 * 读「批准发动的 ask 效果」清单 (`answers`).
 *
 * 没写这个字段 = 没有回答, 标了 `ask` 的效果按自己的 `ask_default` 处理;
 * 写了空数组 = 问过了, 一个都不发动.
 */
function pickAnswers(record: Record<string, unknown>): readonly string[] | undefined {
  const raw = pick(record, ['answers', '批准', '确认']);
  if (raw === undefined) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    return raw.map(item => textOf(item)).filter(Boolean);
  }
  const single = textOf(raw);
  return single ? [single] : [];
}

/** 读一组卡牌 id (支持写一个字符串或一个数组) */
function pickCards(record: Record<string, unknown>, keys: string[]): string[] {
  const raw = pick(record, keys);
  if (raw === undefined || raw === null) {
    return [];
  }
  return (Array.isArray(raw) ? raw : [raw]).map(item => textOf(item)).filter(Boolean);
}

function executeOp(state: BattleState, op: unknown, side: PlayerId): DecisionOpResult {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    return { detail: '跳过: 操作不是对象', applied: false };
  }
  const record = op as Record<string, unknown>;
  const kind = textOf(pick(record, ['do', 'type', '操作'])).toLowerCase();
  if (!kind) {
    return { detail: '跳过: 操作缺少 do 字段', applied: false };
  }

  if (kind === 'play') {
    const card_id = textOf(pick(record, ['card', 'id', '卡']));
    const card = state.cards[card_id];
    if (!card) {
      return { detail: `跳过 上场 ${card_id}: 不存在的卡牌 id`, applied: false };
    }
    if (card.controller !== side) {
      return { detail: `跳过 上场 ${card_id}: 这张卡不属于你`, applied: false };
    }
    if (!canPlayCard(state, card_id)) {
      // 能量不足是最常见的「看着能上场却上不了」, 单独报出来免得 AI / 玩家猜
      const reason =
        card.zone !== 'HAND'
          ? '不在手牌'
          : !canPayEnergy(state, card)
            ? `能量不足 (需要 ${cardCost(card)}, 只有 ${state.players[side].energy})`
            : '场上已满';
      return { detail: `跳过 上场 ${card.name}(${card_id}): ${reason}`, applied: false };
    }
    if (!playCard(state, card_id, pickSlot(record))) {
      return { detail: `跳过 上场 ${card.name}(${card_id}): 上场失败`, applied: false };
    }
    return { detail: `上场 ${card.name}(${card_id})`, applied: true };
  }

  // 下面两条只有演习模式会用 (回放演习时也要能原样重演)
  if (kind === 'practice-play') {
    const card_id = textOf(pick(record, ['card', 'id', '卡']));
    const card = state.cards[card_id];
    if (!card) {
      return { detail: `跳过 从牌库上场 ${card_id}: 不存在的卡牌 id`, applied: false };
    }
    if (!canMoveCardTo(state, card_id, 'FIELD')) {
      return { detail: `跳过 从牌库上场 ${card.name}(${card_id}): 不在牌库或场上已满`, applied: false };
    }
    if (!moveCardTo(state, card_id, 'FIELD', pickSlot(record) ?? null)) {
      return { detail: `跳过 从牌库上场 ${card.name}(${card_id}): 上场失败`, applied: false };
    }
    return { detail: `从牌库上场「${card.name}」`, applied: true };
  }

  if (kind === 'practice-return') {
    const card_id = textOf(pick(record, ['card', 'id', '卡']));
    const card = state.cards[card_id];
    if (!card) {
      return { detail: `跳过 下场 ${card_id}: 不存在的卡牌 id`, applied: false };
    }
    if (!canMoveCardTo(state, card_id, 'DECK')) {
      return { detail: `跳过 下场 ${card.name}(${card_id}): 不在场上`, applied: false };
    }
    if (!moveCardTo(state, card_id, 'DECK', null)) {
      return { detail: `跳过 下场 ${card.name}(${card_id}): 下场失败`, applied: false };
    }
    return { detail: `下场「${card.name}」`, applied: true };
  }

  if (kind === 'attack') {
    const card_id = textOf(pick(record, ['card', 'attacker', 'by', 'from']));
    const target = textOf(pick(record, ['target', 'to', '目标']));
    const card = state.cards[card_id];
    if (!card) {
      return { detail: `跳过 攻击 ${card_id}: 不存在的卡牌 id`, applied: false };
    }
    if (!target) {
      return { detail: `跳过 攻击 ${card_id}: 缺少 target`, applied: false };
    }
    if (isPlayerTarget(target)) {
      if (target === card.controller) {
        return { detail: `跳过 攻击 ${card.name}(${card_id}) → ${target}: 不能攻击自己`, applied: false };
      }
    } else if (!state.cards[target]) {
      return { detail: `跳过 攻击 ${card.name}(${card_id}) → ${target}: 不存在的目标 id`, applied: false };
    }
    if (!canAttack(state, card_id)) {
      return { detail: `跳过 攻击 ${card.name}(${card_id}): 不在场上或本回合已攻击`, applied: false };
    }
    if (!attack(state, card_id, target, { answers: pickAnswers(record) })) {
      return { detail: `跳过 攻击 ${card.name}(${card_id}) → ${target}: 攻击未生效`, applied: false };
    }
    return { detail: `攻击 ${card.name}(${card_id}) → ${cardName(state, target)}`, applied: true };
  }

  if (kind === 'activate') {
    const card_id = textOf(pick(record, ['card', 'use', 'id', '卡']));
    const effect_id = textOf(pick(record, ['effect', 'effect_id', '效果']));
    const card = state.cards[card_id];
    if (!card) {
      return { detail: `跳过 发动 ${card_id}: 不存在的卡牌 id`, applied: false };
    }
    if (!effect_id) {
      return { detail: `跳过 发动 ${card_id}: 缺少 effect`, applied: false };
    }
    if (!activate(state, card_id, effect_id, { answers: pickAnswers(record) })) {
      return { detail: `跳过 发动 ${card.name}(${card_id})#${effect_id}: 代价不足或次数已用尽`, applied: false };
    }
    return { detail: `发动 ${card.name}(${card_id})#${effect_id}`, applied: true };
  }

  // 回答引擎的询问 (目前主要是手牌超上限时选弃哪张)
  if (kind === 'discard' || kind === 'answer') {
    const pending = listAsks(state, side);
    if (pending.length === 0) {
      return { detail: '跳过 回答: 现在没有待回答的询问', applied: false };
    }
    const ask_id = textOf(pick(record, ['ask', 'ask_id', '询问']));
    const ask = ask_id ? pending.find(item => item.id === ask_id) : pending[0];
    if (!ask) {
      return { detail: `跳过 回答 ${ask_id}: 没有这条询问`, applied: false };
    }
    const picked = pickCards(record, ['cards', 'card', '选择', '弃牌', 'choice']);
    if (!resolveAsk(state, ask.id, picked)) {
      return {
        detail: `跳过 回答「${ask.title}」: 要选 ${ask.min}-${ask.max} 张还在手里的卡`,
        applied: false,
      };
    }
    return {
      detail: kind === 'discard' ? `弃掉「${picked.map(id => cardName(state, id)).join('」「')}」` : `回答「${ask.title}」`,
      applied: true,
    };
  }

  if (kind === 'end') {
    return { detail: END_TURN_DETAIL, applied: true };
  }

  return { detail: `跳过: 未知操作 ${kind}`, applied: false };
}

/**
 * 依次执行一组操作 (供面板操作与回放共用).
 *
 * 遇到 `{"do":"end"}` 会停下 (后面的操作不再执行), 但**不会**真的换边 ——
 * 是否结束行动由调用方决定, 这样回放才能按当初记下的步骤原样重演.
 */
export function executeOps(state: BattleState, side: PlayerId, ops: unknown[]): DecisionOpResult[] {
  const outcomes: DecisionOpResult[] = [];
  for (const op of ops) {
    if (state.finished) {
      break;
    }
    const outcome = executeOp(state, op, side);
    outcomes.push(outcome);
    if (outcome.applied && outcome.detail === END_TURN_DETAIL) {
      break;
    }
  }
  return outcomes;
}

/**
 * 把一条已解析的决策应用到战斗.
 *
 * 执行完所有操作后**自动结束本次行动** (AI 不必写 end), 空操作数组表示直接过回合.
 * 注意结束的是「半个回合」(换边给对手), 不是整个回合 —— 双方都收手后才进入回合结算.
 */
export function applyDecision(
  state: BattleState,
  decision: DecisionExtract,
  ai: PlayerId = 'ENEMY',
): DecisionResult {
  const result: DecisionResult = {
    ok: false,
    error: '',
    applied: [],
    ignored: [],
    ended: false,
    finished: state.finished,
    winner: state.winner,
    log: [],
  };

  const reject = (error: string): DecisionResult => ({ ...result, error });

  if (!decision.ok) {
    return reject(decision.error || '决策解析失败');
  }
  if (state.finished) {
    return reject('战斗已经结束');
  }
  if (state.active !== ai) {
    return reject(`现在不是 ${ai} 的回合`);
  }
  if (!decision.ops) {
    return reject('决策格式不正确: 缺少操作数组');
  }
  if (decision.turn !== null && decision.turn !== state.turn) {
    return reject(`回合数不匹配: 决策里写的是 ${decision.turn}, 当前是第 ${state.turn} 回合`);
  }
  if (decision.ops.length > MAX_DECISION_OPS) {
    return reject(`操作数超过上限 (${decision.ops.length} > ${MAX_DECISION_OPS})`);
  }

  result.ok = true;
  const log_start = state.log.length;

  for (const outcome of executeOps(state, ai, decision.ops)) {
    if (outcome.applied) {
      result.applied.push(outcome.detail);
    } else {
      result.ignored.push(outcome.detail);
    }
  }

  if (!state.finished) {
    // 决策块最外层也能带一份 answers: 收手时触发的技能 (SIDE_END / TURN_END) 靠它批准,
    // 因为「结束行动」这条操作是自动补上的, AI 没有地方挂单条的 answers
    const answers = pickAnswers((decision.value ?? {}) as Record<string, unknown>);
    endSide(state, ai, answers === undefined ? undefined : { answers });
    result.ended = true;
  }

  result.finished = state.finished;
  result.winner = state.winner;
  result.log = state.log.slice(log_start).map(entry => entry.message);
  return result;
}

/** 便捷函数: 从文本一步完成「提取 + 应用」 */
export function applyDecisionText(
  state: BattleState,
  text: unknown,
  ai: PlayerId = 'ENEMY',
): { decision: DecisionExtract; result: DecisionResult } {
  const decision = extractDecision(text);
  return { decision, result: applyDecision(state, decision, ai) };
}
