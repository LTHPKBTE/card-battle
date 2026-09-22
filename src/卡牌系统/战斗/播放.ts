// 战斗播放 - 把「一次操作 / 一次回合结算」拆成一帧帧, 交给面板按节奏播出来
//
// 数据从哪来: 引擎每写一条日志都会回调一次 (`ActionOptions.onFrame`), 同步层顺手留一份状态快照,
// 于是「AI 的一次决策」和「回合结算」都变成了一串快照 —— 这里把它整理成真正要播的帧:
//
//   - 局面没变的帧不单独占一格 (它只是叙事), 文字并进下一帧;
//   - 回合结算开始之后的帧标成「结算」, 面板据此换标题与节奏;
//   - 帧太多时折叠尾部 (面板有「跳过」, 但没人想为了看一张卡的结算等两分钟);
//   - 一帧都攒不出来就返回 null (面板照旧直接跳到最终局面).
//
// 播放本身是「演的」: 聊天变量里早就写好了最终局面, 这里只决定画面上先看到什么.
// 所以中途关面板/刷新页面最多少看一段动画, 局面不会因此不一致.
//
// 纯函数, 不依赖酒馆全局, 可直接在 node 中测试.

import type { BattleState, LogEntry } from '../引擎/types.ts';
import { fingerprintState } from './回放.ts';

/** 一帧要播的东西 */
export interface PlaybackFrame {
  /** 这一帧的局面 (引擎状态的一份快照; 面板拿它当「当前状态」渲染) */
  状态: BattleState;
  /** 这一帧的说明 (引擎日志正文; 面板放在进度条上) */
  说明: string;
  /** 操作 = 某一步操作里发生的事; 结算 = 回合结算里发生的事 */
  种类: '操作' | '结算';
  /** 这一帧是第几回合 */
  回合: number;
}

/** 一次播放的全部内容 */
export interface BattlePlayback {
  /** 播放标题 (进度条上显示, 如「AI 行动」) */
  标题: string;
  /** 帧 (旧 → 新) */
  帧: PlaybackFrame[];
}

/** 帧数上限: 超过就把尾部折成一帧 (局面仍是最终那份) */
export const PLAYBACK_FRAME_LIMIT = 24;

/** 结算时的标题 (帧标成「结算」后盖住原来的标题) */
export const SETTLE_TITLE = '回合结算';

/**
 * 这一条日志是不是「回合结算开始了」的记号.
 *
 * `settleRound` 写的第一条 SYSTEM 日志带 `detail.ended_by` (谁结束了行动),
 * 只有它有 —— 所以不用去认中文正文, 改文案也不会失准.
 */
function isSettleMark(entry: LogEntry): boolean {
  return entry.kind === 'SYSTEM' && typeof entry.detail?.ended_by === 'string';
}

/** 这一条日志值不值得各占一格 (DEBUG 是事件流水, engine_only 是引擎自己的问题) */
function isShowable(entry: LogEntry): boolean {
  return entry.level !== 'DEBUG' && !entry.engine_only;
}

/**
 * 把一串状态快照整理成播放帧.
 *
 * @param frames 引擎回调时留下的快照 (旧 → 新; 调用方自行深拷贝好的)
 * @param options.标题 播放标题
 * @param options.起始回合 这次操作开始前的回合号 (用来判断哪些帧已经进入结算)
 * @param options.起点 操作开始前的局面 (可选); 传了就少播一格「什么都没变」的空帧
 */
export function buildBattlePlayback(
  frames: readonly BattleState[],
  options: { 标题: string; 起始回合: number; 起点?: BattleState | null },
): BattlePlayback | null {
  if (frames.length === 0) {
    return null;
  }
  const 帧: PlaybackFrame[] = [];
  let last_key = options.起点 ? fingerprintState(options.起点) : '';
  let pending: string[] = [];
  let settling = false;
  let prev_log = Math.max(0, frames[0].log.length - 1);

  for (const state of frames) {
    // 触发这一帧的那条日志一定在末尾; 中间夹着的 (没留快照的) 也都算这一帧的说明
    const added = state.log.length > prev_log ? state.log.slice(prev_log) : state.log.slice(-1);
    prev_log = state.log.length;
    if (added.some(isSettleMark)) {
      settling = true;
    }
    pending.push(...added.filter(isShowable).map(entry => entry.message));

    const key = fingerprintState(state);
    if (key === last_key) {
      // 局面和上一帧一样: 这句话先攒着, 跟下一帧一起说
      continue;
    }
    last_key = key;
    帧.push({
      状态: state,
      说明: pending.join('；'),
      种类: settling || state.turn > options.起始回合 ? '结算' : '操作',
      回合: state.turn,
    });
    pending = [];
  }

  if (帧.length === 0) {
    return null;
  }
  if (帧.length > PLAYBACK_FRAME_LIMIT) {
    // 尾部折成一帧: 前面照常一格格播, 剩下的说明并在最后一格上, 局面仍是最终那份
    const kept = 帧.slice(0, PLAYBACK_FRAME_LIMIT - 1);
    const tail = 帧.slice(PLAYBACK_FRAME_LIMIT - 1);
    kept.push({
      ...tail[tail.length - 1],
      说明: tail.map(item => item.说明).filter(Boolean).join('；'),
    });
    return { 标题: options.标题, 帧: kept };
  }
  return { 标题: options.标题, 帧 };
}
