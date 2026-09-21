// 战斗引擎 - 卡牌筛选与目标解析

import { pickRandom } from './rng.ts';
import {
  PLAYER_IDS,
  type BattleState,
  type CardInstance,
  type CardQuery,
  type PlayerId,
  type ResolveScope,
  type SortKey,
  type Target,
  type TargetQuery,
  type TargetSpec,
  otherPlayer,
  type Zone,
} from './types.ts';

/** 区域的默认排序权重 (场上优先) */
const ZONE_ORDER: readonly Zone[] = ['FIELD', 'HAND', 'DECK', 'GRAVEYARD', 'BANISHED'];

/** 默认排序: 场上位置 → 卡实例 id, 保证结果确定 */
function compareDefault(a: CardInstance, b: CardInstance): number {
  const zone_diff = ZONE_ORDER.indexOf(a.zone) - ZONE_ORDER.indexOf(b.zone);
  if (zone_diff !== 0) {
    return zone_diff;
  }
  const slot_diff = (a.slot ?? 99) - (b.slot ?? 99);
  if (slot_diff !== 0) {
    return slot_diff;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 按指定方式排序 (RANDOM 会消耗随机数) */
export function sortCards(state: BattleState, cards: CardInstance[], sort: SortKey | undefined): CardInstance[] {
  const list = [...cards];
  switch (sort) {
    case 'ATK_DESC':
      return list.sort((a, b) => b.current.atk - a.current.atk || compareDefault(a, b));
    case 'ATK_ASC':
      return list.sort((a, b) => a.current.atk - b.current.atk || compareDefault(a, b));
    case 'SHIELD_DESC':
      return list.sort((a, b) => b.current.shield - a.current.shield || compareDefault(a, b));
    case 'SHIELD_ASC':
      return list.sort((a, b) => a.current.shield - b.current.shield || compareDefault(a, b));
    case 'HP_ASC':
      return list.sort((a, b) => a.current.hp - b.current.hp || compareDefault(a, b));
    case 'HP_DESC':
      return list.sort((a, b) => b.current.hp - a.current.hp || compareDefault(a, b));
    case 'RANDOM':
      // Fisher-Yates, 用引擎随机数保证可复现
      for (let i = list.length - 1; i > 0; i -= 1) {
        const picked = pickRandom(state, list.slice(0, i + 1));
        const j = picked ? list.indexOf(picked) : i;
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    default:
      return list.sort(compareDefault);
  }
}

/** 某个玩家某区域中的卡 */
export function cardsInZone(state: BattleState, player: PlayerId, zone: Zone): CardInstance[] {
  const ids = state.players[player][zoneKey(zone)];
  return ids.map(id => state.cards[id]).filter((card): card is CardInstance => Boolean(card));
}

/** 区域 → PlayerState 上的字段名 */
export function zoneKey(zone: Zone): 'deck' | 'hand' | 'field' | 'graveyard' | 'banished' {
  switch (zone) {
    case 'DECK':
      return 'deck';
    case 'HAND':
      return 'hand';
    case 'FIELD':
      return 'field';
    case 'GRAVEYARD':
      return 'graveyard';
    case 'BANISHED':
      return 'banished';
  }
}

/** 按查询条件筛选卡牌 (不排序) */
export function filterCards(scope: ResolveScope, query: CardQuery): CardInstance[] {
  const { state, controller, source, event } = scope;
  const opponent = otherPlayer(controller);

  const matched = Object.values(state.cards).filter(card => {
    if (query.zone && card.zone !== query.zone) {
      return false;
    }
    if (query.controller) {
      const wanted = query.controller === 'SELF' ? controller : opponent;
      if (card.controller !== wanted) {
        return false;
      }
    }
    if (query.owner) {
      const wanted = query.owner === 'SELF' ? controller : opponent;
      if (card.owner !== wanted) {
        return false;
      }
    }
    if (query.series !== undefined && card.series !== query.series) {
      return false;
    }
    if (query.type !== undefined && card.type !== query.type) {
      return false;
    }
    if (query.name !== undefined && card.name !== query.name) {
      return false;
    }
    if (query.rarity !== undefined && card.rarity !== query.rarity) {
      return false;
    }
    if (query.has_status !== undefined && !hasStatus(state, card, query.has_status)) {
      return false;
    }
    if (query.exclude_self && source && card.id === source.id) {
      return false;
    }
    if (query.exclude_event_target && event?.target && card.id === event.target) {
      return false;
    }
    return true;
  });

  return matched.sort(compareDefault);
}

/** 卡牌是否带有指定状态 (按 key) */
export function hasStatus(state: BattleState, card: CardInstance, key: string): boolean {
  return card.statuses.some(id => state.statuses[id]?.key === key);
}

/** 场上第一个空位 */
export function firstFreeSlot(state: BattleState, player: PlayerId): number {
  const used = new Set(cardsInZone(state, player, 'FIELD').map(card => card.slot));
  for (let i = 0; i < 99; i += 1) {
    if (!used.has(i)) {
      return i;
    }
  }
  return 99;
}

/**
 * 按目标描述解析出目标列表.
 *
 * 返回的是 `Target` (卡牌实例 id 或玩家 id), 玩家目标只有 CONTROLLER / OPPONENT /
 * 事件目标本身是玩家时才会出现.
 */
export function resolveTargets(
  scope: ResolveScope,
  spec: TargetSpec | undefined,
  fallback: TargetSpec = 'SELF',
): Target[] {
  const actual = spec ?? fallback;

  if (typeof actual === 'string') {
    switch (actual) {
      case 'SELF':
        return scope.source ? [scope.source.id] : [];
      case 'CONTROLLER':
        return [scope.controller];
      case 'OPPONENT':
        return [otherPlayer(scope.controller)];
      case 'EVENT_ACTOR':
        return scope.event?.actor ? [scope.event.actor] : [];
      case 'EVENT_TARGET':
        return scope.event?.target ? [scope.event.target] : [];
      case 'EVENT_SOURCE':
        return scope.event?.source ? [scope.event.source] : [];
      case 'ALL_ALLIES':
        return cardsInZone(scope.state, scope.controller, 'FIELD').map(card => card.id);
      case 'ALL_ENEMIES':
        return cardsInZone(scope.state, otherPlayer(scope.controller), 'FIELD').map(card => card.id);
      case 'ALL_FIELD':
        return PLAYER_IDS.flatMap(player => cardsInZone(scope.state, player, 'FIELD')).map(card => card.id);
      case 'RANDOM_ALLY': {
        const picked = pickRandom(scope.state, cardsInZone(scope.state, scope.controller, 'FIELD'));
        return picked ? [picked.id] : [];
      }
      case 'RANDOM_ENEMY': {
        const picked = pickRandom(scope.state, cardsInZone(scope.state, otherPlayer(scope.controller), 'FIELD'));
        return picked ? [picked.id] : [];
      }
      case 'LOOP_ITEM':
        // FOR_EACH 当前项; 循环外解析为空 (所以循环体外的 LOOP_ITEM 是安全的「没有目标」)
        return scope.item ? [scope.item] : [];
      default:
        return [];
    }
  }

  if ('id' in actual) {
    return scope.state.cards[actual.id] ? [actual.id] : [];
  }

  const query = actual as TargetQuery;
  const matched = sortCards(scope.state, filterCards(scope, query), query.sort);
  const limited = query.max === undefined ? matched : matched.slice(0, query.max);
  return limited.map(card => card.id);
}
