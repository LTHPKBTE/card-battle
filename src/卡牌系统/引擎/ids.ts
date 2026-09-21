// 战斗引擎 - 可序列化的 id 生成
//
// 计数器存在 state.counters 里, 因此存档/读档后 id 不会重复.

import type { BattleState } from './types.ts';

/** 生成形如 `m12` 的 id */
export function nextId(state: BattleState, prefix: string): string {
  const key = `__id_${prefix}`;
  const n = (state.counters[key] ?? 0) + 1;
  state.counters[key] = n;
  return `${prefix}${n}`;
}
