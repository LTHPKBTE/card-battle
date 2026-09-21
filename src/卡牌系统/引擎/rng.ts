// 战斗引擎 - 可播种随机数
//
// 随机数不保存在闭包里, 而是由 (seed, 调用序号) 推导, 因此整个战斗状态可序列化、
// 同一 seed 必然复现同一场战斗 (测试与回放的前提).

import type { BattleState } from './types.ts';

/** 随机数计数器在全局计数器中的键 */
const RNG_COUNTER = '__rng';

/** 把 (seed, n) 混合成 [0, 1) 的浮点数 (mulberry32 的混合函数) */
function hashToUnit(seed: number, n: number): number {
  let t = (seed + Math.imul(n, 0x6d2b79f5)) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 取下一个随机数 [0, 1) */
export function nextRandom(state: BattleState): number {
  const n = (state.counters[RNG_COUNTER] ?? 0) + 1;
  state.counters[RNG_COUNTER] = n;
  return hashToUnit(state.seed, n);
}

/** 取 [0, maxExclusive) 的整数 */
export function randomInt(state: BattleState, maxExclusive: number): number {
  if (maxExclusive <= 0) {
    return 0;
  }
  return Math.floor(nextRandom(state) * maxExclusive);
}

/** 从数组中随机取一个元素 */
export function pickRandom<T>(state: BattleState, items: readonly T[]): T | null {
  if (items.length === 0) {
    return null;
  }
  return items[randomInt(state, items.length)] ?? null;
}
