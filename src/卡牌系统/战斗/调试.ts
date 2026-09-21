// 战斗 · 调试信息 (战斗面板「调试」弹窗的数据源)
//
// 面板与酒馆 AI 之间只有两条数据通路, 这个模块把它们都摊开来看:
//
//   去 —— 世界书条目按当前变量渲染出来的注入文本 (决策协议 / 双方操控说明 / 本回合简报);
//   回 —— 聊天里最近的 assistant 楼层原文, 以及脚本从里面提取到的决策块.
//
// 「去」这一侧不能直接调 battleEntryContent(): 那是带 `{{if}}` 的模板, 宏要由酒馆展开.
// 这里按同样的条件自己渲染一遍, 得到的就是 AI 真正看到的文本 ——
// 条件写在 世界书.ts 的 battleEntryContent() 里, 两边的判断必须保持一致.
//
// 收集逻辑尽量做成纯函数 (只有 collectDebugReplies 碰酒馆全局), 这样能在 node 里测.

import { extractDecision } from './决策.ts';
import { describeStep, type ReplayReport, type ReplaySize } from './回放.ts';
import { BRIEF_HEADING, bothSidesNote, protocolText } from './协议.ts';
import { BATTLE_AI_PATH, type BattleAIStore, type ReplayStep } from './schema.ts';

/**
 * 一次最多回看多少条聊天楼层来找 AI 回复.
 *
 * 楼层范围里的 user / system 楼层会被 getChatMessages 按 role 过滤掉,
 * 所以真正取到的条数可能少于这个数.
 */
export const DEBUG_MESSAGE_SCAN = 40;

/** 变量 JSON 最多展示多少字符 (局面快照会很长, 超出只截断展示) */
export const DEBUG_JSON_LIMIT = 20000;

/** 可选的「显示多少条 AI 回复」 */
export const DEBUG_REPLY_LIMITS: readonly number[] = [1, 3, 5, 10];

/** 默认显示几条 AI 回复 */
export const DEBUG_REPLY_LIMIT_DEFAULT = 3;

/** 世界书条目会注入给 AI 的一段文本 */
export interface DebugSegment {
  /** 段名 */
  title: string;
  /** 生效条件 (世界书条目里的 {{if}}) */
  condition: string;
  /** 条件是否成立 */
  active: boolean;
  /** 生效时注入的正文; 未生效时为空串 */
  text: string;
}

/** 一条 AI 楼层 (原文 + 提取结果) */
export interface DebugReply {
  message_id: number;
  /** 楼层原文 */
  text: string;
  /** 提取到的决策块原文 (含标签); 没提取到为空串 */
  decision_raw: string;
  /** 是否提取到可用的决策 */
  decision_ok: boolean;
  /** 没提取到时的原因 */
  decision_error: string;
  /** 决策里的操作条数; 没解析出来为 null */
  ops: number | null;
}

/** 调试面板里列一条回放步骤 */
export interface DebugReplayLine {
  /** 步骤序号 */
  序号: number;
  /** 展示文本 */
  文本: string;
  /** 是否为 AI 决策的锤点 (那一层被重新生成时会退回这里) */
  锤点: boolean;
}

/** 回放数据在调试面板里的摘要 */
export interface DebugReplay {
  /** 列出来的步骤 (只取最新的若干条) */
  步骤: DebugReplayLine[];
  /** 步骤总数 */
  总数: number;
  /** 起点之前已合并掉的步数 */
  已丢弃: number;
  /** 是否有起点快照 */
  有起点: boolean;
  /** 体积明细 (字符数) */
  体积: ReplaySize;
  /** 重放出来的局面与当前是否一致 */
  一致: boolean;
  /** 不一致 / 失败时的说明 */
  说明: string;
}

/** 回放步骤最多列多少条 (从最新的往回数) */
export const DEBUG_REPLAY_LINE_LIMIT = 30;

/**
 * 把回放体检报告 + 步骤整理成调试面板要的样子.
 *
 * 体检报告由 同步.ts 算好传进来 —— 它会整体重放一遍, 代价不小,
 * 不能让「读变量」这种小事顺手就做.
 */
export function buildDebugReplay(report: ReplayReport | null, steps: ReplayStep[], dropped: number): DebugReplay | null {
  if (!report) {
    return null;
  }
  return {
    步骤: steps.slice(-DEBUG_REPLAY_LINE_LIMIT).map(step => ({
      序号: step.序号,
      文本: describeStep(step),
      锤点: step.楼层 !== null,
    })),
    总数: steps.length,
    已丢弃: dropped,
    有起点: report.有起点,
    体积: report.体积,
    一致: report.一致,
    说明: report.错误 || report.差异,
  };
}

/** 调试弹窗要展示的全部内容 */
export interface BattleDebugInfo {
  /** 是否处于演习 (演习不写任何聊天变量, 所以不会有任何注入) */
  practice: boolean;
  /** 世界书条目会注入的三段 */
  segments: DebugSegment[];
  /** 生效部分拼起来的完整文本 (AI 真正看到的就是它) */
  prompt: string;
  /** 最近的 AI 回复 (旧 → 新) */
  replies: DebugReply[];
  /** 上一次决策的结算结果 */
  result: string;
  /** 本次会话里每次决策的结算结果 (旧 → 新) */
  decisions: string[];
  /** 本回合的操作记录 (旧 → 新) */
  ops: string[];
  /** 聊天变量 战斗.AI 的 JSON 快照 */
  store_json: string;
  /** JSON 是否因为太长被截断 */
  store_truncated: boolean;
  /** 回放数据摘要 (没有战斗时为 null) */
  replay: DebugReplay | null;
}

/**
 * 按世界书条目的条件渲染三段注入文本.
 *
 * 与 世界书.ts 的 battleEntryContent() 一一对应, 改动那边时这里要跟着改.
 */
export function buildDebugSegments(store: BattleAIStore): DebugSegment[] {
  return [
    {
      title: '决策协议',
      condition: `${BATTLE_AI_PATH}.待决策`,
      active: store.待决策,
      text: store.待决策 ? protocolText() : '',
    },
    {
      title: '双方操控说明',
      condition: `${BATTLE_AI_PATH}.用户操控双方`,
      active: store.用户操控双方,
      text: store.用户操控双方 ? bothSidesNote() : '',
    },
    {
      title: '本回合简报',
      condition: `${BATTLE_AI_PATH}.进行中`,
      active: store.进行中,
      text: store.进行中 ? `${BRIEF_HEADING}\n${store.简报}` : '',
    },
  ];
}

/** 把生效的段拼成完整提示词 (与酒馆渲染世界书条目的结果等价) */
export function renderDebugPrompt(segments: DebugSegment[]): string {
  return segments
    .filter(segment => segment.active)
    .map(segment => segment.text)
    .join('\n\n');
}

/** 序列化变量快照, 过长时截断 (只影响展示, 不影响数据) */
function safeJson(value: unknown): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? '';
  } catch (error) {
    return { text: `(无法序列化: ${String(error)})`, truncated: false };
  }
  if (text.length <= DEBUG_JSON_LIMIT) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, DEBUG_JSON_LIMIT), truncated: true };
}

/** 读取最近若干条 AI 楼层, 并试着从每条里提取决策 (读不到消息时返回空数组) */
export function collectDebugReplies(limit: number): DebugReply[] {
  let messages: ChatMessage[];
  try {
    messages = getChatMessages(`-${DEBUG_MESSAGE_SCAN}`, { role: 'assistant' });
  } catch (error) {
    // 欢迎页 / 聊天还没加载好时读不到楼层, 当作「没有回复」
    console.warn('[卡牌战斗] 读取聊天楼层失败, 调试面板按没有回复处理:', error);
    return [];
  }
  return messages.slice(-Math.max(1, limit)).map(toDebugReply);
}

/** 把一条楼层整理成调试条目 */
function toDebugReply(message: ChatMessage): DebugReply {
  const text = String(message.message ?? '');
  const decision = extractDecision(text);
  return {
    message_id: message.message_id,
    text,
    decision_raw: decision.raw,
    decision_ok: decision.ok,
    decision_error: decision.ok ? '' : decision.error,
    ops: decision.ops ? decision.ops.length : null,
  };
}

/**
 * 汇总调试信息 (纯函数: 楼层数据由调用方先取好).
 *
 * 结算结果直接从变量里的 `结果` 取, 不额外传参 —— 面板上看到的就是变量里的那一份.
 */
export function collectBattleDebug(params: {
  store: BattleAIStore;
  replies: DebugReply[];
  /** 本次会话里每次决策的结算结果 (旧 → 新) */
  decisions: string[];
  /** 本回合的操作记录 (旧 → 新) */
  ops: string[];
  /** 是否处于演习模式 */
  practice?: boolean;
  /** 回放体检报告 (由 同步.ts 算好; 演习 / 没战斗时为 null) */
  replay?: ReplayReport | null;
}): BattleDebugInfo {
  const segments = buildDebugSegments(params.store);
  const json = safeJson(params.store);
  return {
    practice: Boolean(params.practice),
    segments,
    prompt: renderDebugPrompt(segments),
    replies: params.replies.slice(),
    result: params.store.结果,
    decisions: params.decisions.slice(),
    ops: params.ops.slice(),
    store_json: json.text,
    store_truncated: json.truncated,
    replay: buildDebugReplay(params.replay ?? null, params.store.回放.步骤, params.store.回放.已丢弃),
  };
}
