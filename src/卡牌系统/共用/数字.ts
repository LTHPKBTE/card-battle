/**
 * 数字输入框的规范化逻辑 (纯函数, 便于 node 测试).
 *
 * 设计原则: 输入过程中不校验、不写回, 用户可以把内容完全删空或停在中间态;
 * 只在失焦 / 回车 / 明确提交时用这里的函数规范化一次, 再写回上层.
 * 这样「清空后重新输入」不会被回退值顶回来.
 */

export interface NumberInputOptions {
  /** 允许的最小值 */
  min?: number;
  /** 允许的最大值 */
  max?: number;
  /** 是否只允许整数 (默认 true) */
  integer?: boolean;
  /** 清空或填了非法内容时使用的回退值 (默认 min ?? 0) */
  fallback?: number;
}

/** 取整 (按需) 并夹到 [min, max] */
function clamp(value: number, options: NumberInputOptions): number {
  let result = options.integer === false ? value : Math.trunc(value);
  if (options.min !== undefined) {
    result = Math.max(result, options.min);
  }
  if (options.max !== undefined) {
    result = Math.min(result, options.max);
  }
  return result;
}

/** 把输入框文本规范化成合法数字; 空串或非法内容返回 null */
export function normalizeNumberInput(text: string, options: NumberInputOptions = {}): number | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? clamp(value, options) : null;
}

/** 空串/非法内容时使用的回退值 (同样受 min/max 约束) */
export function numberInputFallback(options: NumberInputOptions = {}): number {
  return clamp(options.fallback ?? options.min ?? 0, options);
}

/** 规范化并保证返回一个合法数字 (非法时用回退值) */
export function resolveNumberInput(text: string, options: NumberInputOptions = {}): number {
  return normalizeNumberInput(text, options) ?? numberInputFallback(options);
}
