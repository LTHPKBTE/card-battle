// 战斗 · 会话同步 (酒馆侧桥接层)
//
// 把「引擎状态」「聊天变量」「消息事件」串成一条链路:
//
//   面板操作 (任一方) ──► 引擎结算 ──► 记一步回放 + 写变量 + 重算简报
//                                      │
//                   世界书条目 {{if 待决策/用户操控双方/进行中}} 注入系统提示词 (条目由用户手动安装)
//                                      │
//                              AI 回复里带 <battle_action>
//                                      │
//               MESSAGE_RECEIVED ──► 解析 + 校验 + 应用 ──► 再同步
//
// 回放 (可选但默认开着) 让战斗可以「退回去重演」:
//
//   每一步操作都被记成结构化的 ReplayStep (见 回放.ts), 连同 AI 决策所在的楼层一起写进变量;
//   那个楼层被重新生成 / 编辑 / 删除时, 战斗就回退到该步之前, 再用同一份配置重放 ——
//   引擎的随机数由 (种子, 序号) 推导, 所以重放必然得到同样的局面 (旧分支直接丢弃).
//
// 两种会话模式:
// - BATTLE   —— 正式战斗. 写聊天变量, 世界书条目生效, AI 在敌方回合输出决策块.
// - PRACTICE —— 演习. 玩家自由操作两边, **完全不写聊天变量**, 所以不会触发世界书注入,
//               也不会把「战斗中」的状态传给 AI. 刷新页面后会丢失 (回放步骤也只留在内存).
//
// 这一层是唯一接触酒馆全局的地方, 所以不做 node 测试 (纯逻辑都在 简报.ts / 决策.ts / 回放.ts).
// 注意: 这里**不会**自动创建/删除世界书条目, 也不会自动触发 AI 生成;
// 世界书由用户导入 世界书-卡牌战斗.json 后自行绑定 (全局/角色/聊天均可).

import { loadCards } from '../卡牌/data.ts';
import {
  attachBattleConfig,
  attack,
  activate,
  BATTLE_VERSION,
  canAttack,
  canMoveCardTo,
  canPlayCard,
  createBattle,
  endSide,
  listActivatable,
  listAskable,
  listAsks,
  moveCardTo,
  normalizeBattleState,
  playCard,
  resolveAsk,
  startBattle,
  syncPlayerEnergy,
  type AskableEffect,
  type AskRequest,
  type BattleConfig,
} from '../引擎/battle.ts';
import { createCardProvider } from '../引擎/适配.ts';
import type { BattleState, CardDefinition, CardProvider, EffectTiming, PlayerId } from '../引擎/types.ts';
import { briefText } from './简报.ts';
import { notify } from '../共用/通知.ts';
import { applyDecision, extractDecision, type DecisionResult } from './决策.ts';
import {
  compactReplay,
  inspectReplay,
  hashText,
  replayBattle,
  rewindCountFor,
  shiftAnchorsAfterDelete,
  stepMatchesFingerprint,
  type ReplayReport,
} from './回放.ts';
import {
  BATTLE_AI_PATH,
  BATTLE_STORE_VERSION,
  BattleAIStoreSchema,
  BattleSetupSchema,
  type BattleAIStore,
  type BattleSetup,
  type ReplayStep,
} from './schema.ts';
import { checkBattleWorldbook, type BattleWorldbookStatus } from './世界书.ts';

/** AI 控制的阵营 (人类玩家控制另一边) */
export const AI_SIDE: PlayerId = 'ENEMY';

/** 人类玩家控制的阵营 */
export const HUMAN_SIDE: PlayerId = 'PLAYER';

/** 变量里最多保留多少条战斗日志 */
export const BATTLE_LOG_LIMIT = 40;

/**
 * 写进变量的局面快照里最多带多少条日志.
 *
 * 引擎现在会记录全部等级 (含事件流水), 长局的 `state.log` 可以很长;
 * 直接整份写进聊天变量会把变量撑得很大, 所以只存最近一段 ——
 * 刷新页面后面板仍能看到最近的记录, 内存里的 `state.log` 不受影响.
 */
export const BATTLE_SNAPSHOT_LOG_LIMIT = 200;

/** 内存里最多保留多少条 AI 决策记录 */
export const BATTLE_DECISION_LIMIT = 20;

/** 会话模式: 正式战斗 / 演习 */
export type BattleMode = 'BATTLE' | 'PRACTICE';

/** 可以被翻看的牌堆区域 */
export type PileZone = 'DECK' | 'GRAVEYARD' | 'BANISHED';

/** 当前会话 (内存缓存; 刷新页面后由 getBattleState 从变量恢复) */
let session: {
  state: BattleState;
  setup: BattleSetup;
  mode: BattleMode;
  /** 回放步骤 (旧 → 新): 正式战斗会写进变量, 演习只留在内存 */
  steps: ReplayStep[];
  /** 起点快照 (步骤过多时由 compactReplay 合并出来; null = 从开局重放) */
  base: unknown | null;
  /** 起点之前已经合并掉多少步 (只影响展示里的序号) */
  dropped: number;
  /** 本次会话里每次 AI 决策的结算结果 (旧 → 新); 步 = 它来自第几步, 回退时按它截断 */
  decisions: { 步: number; 文本: string }[];
} | null = null;

/** 卡牌查询提供者的缓存 (卡牌库改动后调用 resetBattleCache) */
let cached_provider: CardProvider | null = null;

function getProvider(): CardProvider {
  if (!cached_provider) {
    cached_provider = createCardProvider(loadCards()).provider;
  }
  return cached_provider;
}

/** 卡牌库被编辑后清掉提供者缓存 */
export function resetBattleCache(): void {
  cached_provider = null;
}

// ---------------------------------------------------------------------------
// 变量读写
// ---------------------------------------------------------------------------

/**
 * 读取 `战斗.AI` 变量 (不存在或格式不对时返回全默认值).
 *
 * 这里必须容错: 旧版本写下的变量、用户手改过的变量都可能不合 schema,
 * 一旦 parse 抛错, 面板里的每个操作都会在 await 处中断 (状态已经变了但界面不刷新).
 */
export function readBattleStore(): BattleAIStore {
  let raw: unknown;
  try {
    raw = _.get(getVariables({ type: 'chat' }), BATTLE_AI_PATH);
  } catch (error) {
    console.warn('[卡牌战斗] 读取聊天变量失败, 本次按默认值处理:', error);
    return BattleAIStoreSchema.parse({});
  }
  const parsed = BattleAIStoreSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return parsed.data;
  }
  console.warn(
    '[卡牌战斗] 战斗变量格式不对, 已按默认值处理 (可在变量管理器里删掉 战斗.AI 重置):',
    parsed.error.message,
  );
  return BattleAIStoreSchema.parse({});
}

/** 写回 `战斗.AI` 变量 */
function writeBattleStore(store: BattleAIStore): void {
  updateVariablesWith(variables => {
    _.set(variables, BATTLE_AI_PATH, store);
    return variables;
  }, { type: 'chat' });
}

/** 判断一份反序列化出来的数据是否像战斗状态 */
function looksLikeBattleState(value: unknown): value is BattleState {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const state = value as Partial<BattleState>;
  return Boolean(state.players?.PLAYER && state.players?.ENEMY && state.cards && Array.isArray(state.log));
}

/**
 * 快照能不能直接续战.
 *
 * 回合模型改版后 (一个回合 = 双方各行动一次) 旧快照缺 `active_index` / `first_side`,
 * 硬读上去回合会错乱, 所以版本不一致就当作没有这场战斗 (不动 store, 交给 syncBattle 清掉).
 */
function isCompatibleSnapshot(state: BattleState): boolean {
  return state.version === BATTLE_VERSION && typeof state.active_index === 'number' && Boolean(state.first_side);
}

/** 把存储用的配置还原成引擎配置 */
function toBattleConfig(setup: BattleSetup): BattleConfig {
  return {
    card_provider: getProvider(),
    player_deck: setup.我方卡组,
    enemy_deck: setup.敌方卡组,
    seed: setup.种子,
    player_hp: setup.我方生命,
    enemy_hp: setup.敌方生命,
    field_size: setup.场上上限,
    opening_hand: setup.开局手牌,
    hand_limit: setup.手牌上限,
    energy: {
      enabled: setup.能量开关,
      start: setup.起始能量,
      per_turn: setup.能量增长,
      cap: setup.能量上限,
      refill: setup.能量补满,
    },
    first: setup.先手,
    recycle: setup.牌库轮换,
  };
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/**
 * 取得当前战斗状态.
 *
 * 优先用内存里的会话; 没有时从变量恢复 (刷新页面 / 切聊天后仍能续战).
 */
export function getBattleState(): BattleState | null {
  if (session) {
    return session.state;
  }
  const store = readBattleStore();
  if (!store.进行中 || !store.局面 || !store.配置) {
    return null;
  }
  if (!looksLikeBattleState(store.局面)) {
    return null;
  }
  if (store.版本 !== BATTLE_STORE_VERSION || !isCompatibleSnapshot(store.局面)) {
    console.warn(
      `[卡牌战斗] 变量里的战斗快照是旧版本 (${store.版本} → ${BATTLE_STORE_VERSION}), 已丢弃; 需要重新开战.`,
    );
    store.进行中 = false;
    store.待决策 = false;
    store.简报 = '';
    store.本回合操作 = [];
    store.局面 = null;
    store.配置 = null;
    store.回放 = { 步骤: [], 起点: null, 已丢弃: 0 };
    store.版本 = BATTLE_STORE_VERSION;
    writeBattleStore(store);
    return null;
  }
  const setup = BattleSetupSchema.parse(store.配置);
  // 旧快照没有「战斗级变量池」/ 能量 / 询问这些新字段, 统一补齐
  attachBattleConfig(store.局面, toBattleConfig(setup));
  normalizeBattleState(store.局面);
  // 回放步骤从变量里恢复; 没有的话 (旧版本存下的战斗) 就只能续战, 不能逐步回退
  const steps = store.回放.步骤.map(step => ({ ...step, 操作: step.操作.slice() }));
  session = { state: store.局面, setup, mode: 'BATTLE', steps, base: store.回放.起点, dropped: store.回放.已丢弃, decisions: [] };
  return session.state;
}

/** 当前会话模式 (没有会话时返回 null) */
export function getSessionMode(): BattleMode | null {
  return session?.mode ?? null;
}

/** 当前会话的配置 (没有会话时返回 null) */
export function getSessionSetup(): BattleSetup | null {
  return session?.setup ?? null;
}

/** 本次会话的操作记录 (旧 → 新; 直接由回放步骤派生, 两边不会对不上) */
export function getSessionOps(): string[] {
  return session ? stepsToOps(session.steps) : [];
}

/** 本次会话的回放步骤 (旧 → 新); 演习与刷新后可能为空 */
export function getSessionSteps(): ReplayStep[] {
  return session ? session.steps.map(step => ({ ...step, 操作: step.操作.slice() })) : [];
}

/** 当前会话的起点之前已合并掉多少步 (展示序号用) */
export function getSessionDropped(): number {
  return session?.dropped ?? 0;
}

/** 上一次 AI 决策的结算结果 (日志弹窗展示用; 演习 / 没决策过时为空串) */
export function getLastDecisionResult(): string {
  if (session?.mode === 'PRACTICE') {
    return '';
  }
  return readBattleStore().结果;
}

/** 本次会话里每次 AI 决策的结算结果 (旧 → 新; 刷新页面后为空) */
export function getDecisionLog(): string[] {
  return session ? session.decisions.map(item => item.文本) : [];
}

/**
 * 查一张战斗中的卡对应的卡牌库定义 (详情弹窗展示卡面描述用).
 *
 * 接受卡牌实例 id 或卡牌库 id; 查不到返回 null.
 */
export function getCardDefinition(card_id: string): CardDefinition | null {
  const instance = getBattleState()?.cards[card_id];
  return getProvider()(instance?.card_id ?? card_id);
}

/**
 * 该方的牌库/墓地/除外能否被查看.
 *
 * 演习模式两边都能看; 正式战斗只能看自己的牌库,
 * 但墓地/除外本来就是公开信息, 两边都能看.
 */
export function canViewPile(side: PlayerId, zone: PileZone = 'DECK'): boolean {
  if (session?.mode === 'PRACTICE' || side === HUMAN_SIDE) {
    return true;
  }
  return zone === 'GRAVEYARD' || zone === 'BANISHED';
}

/** 现在是否是演习模式 (两边都能看牌库 + 自由上场/下场) */
export function canFreelyArrange(): boolean {
  return session?.mode === 'PRACTICE';
}

/** 现在是否是演习模式 */
export function isPracticeMode(): boolean {
  return session?.mode === 'PRACTICE';
}

/** 是否开启了「双方操控」开关 (仅战斗模式有意义) */
export function isControllingBothSides(): boolean {
  return readBattleStore().用户操控双方;
}

/** 当前战斗是否正在进行 */
export function isBattleRunning(): boolean {
  const state = getBattleState();
  return Boolean(state && !state.finished);
}

/** 现在是否在等 AI 决策 */
export function isBattleWaitingForAI(): boolean {
  const state = getBattleState();
  if (!state || state.finished || state.active !== AI_SIDE) {
    return false;
  }
  // 双方操控时玩家自己把两边都打了, 不需要 AI 输出决策
  return session?.mode === 'PRACTICE' ? false : !readBattleStore().用户操控双方;
}

/** 开始一场新战斗 (写变量并同步; 世界书条目需要用户自己安装) */
export async function startBattleSession(setup: BattleSetup): Promise<BattleState> {
  const parsed = BattleSetupSchema.parse(setup);
  const state = createBattle(toBattleConfig(parsed));
  startBattle(state);
  session = { state, setup: parsed, mode: 'BATTLE', steps: [], base: null, dropped: 0, decisions: [] };
  await syncBattle();
  void warnIfWorldbookMissing();
  return state;
}

/**
 * 开始一场演习 (不写任何聊天变量).
 *
 * 已经在正式战斗中时返回 null —— 避免演习与正式战斗共用一份状态而互相干扰.
 */
export async function startPracticeSession(setup: BattleSetup): Promise<BattleState | null> {
  // 当前已经是演习时允许直接重开; 只有「正式战斗进行中」才拒绝
  if (session?.mode !== 'PRACTICE' && isBattleRunning()) {
    return null;
  }
  const parsed = BattleSetupSchema.parse(setup);
  const state = createBattle(toBattleConfig(parsed));
  startBattle(state);
  session = { state, setup: parsed, mode: 'PRACTICE', steps: [], base: null, dropped: 0, decisions: [] };
  return state;
}

/** 重置演习 (用同一份配置重新开始) */
export async function resetPracticeSession(): Promise<BattleState | null> {
  if (!session || session.mode !== 'PRACTICE') {
    return null;
  }
  return startPracticeSession(session.setup);
}

/**
 * 演习中开关能量系统.
 *
 * 能量本来只能开局时定, 开打之后就锁死了 —— 演习是拿来试规则的, 得能中途改.
 * 做法是换一份配置重新挂上去, 再把两边能量按新曲线重算 (关掉时顺手清 0,
 * 免得卡面上挂着一个花不掉的数字). 新配置同时写回 `session.setup`,
 * 所以「重置演习」后依然是这个开关值.
 */
export function setPracticeEnergyEnabled(enabled: boolean): BattleState | null {
  if (!session || session.mode !== 'PRACTICE') {
    return null;
  }
  const setup = BattleSetupSchema.parse({ ...session.setup, 能量开关: enabled });
  session.setup = setup;
  attachBattleConfig(session.state, toBattleConfig(setup));
  syncPlayerEnergy(session.state, HUMAN_SIDE);
  syncPlayerEnergy(session.state, AI_SIDE);
  return session.state;
}

/** 结束当前会话 (正式战斗会清掉变量里的快照; 演习直接丢弃) */
export async function endBattleSession(): Promise<void> {
  const was_practice = session?.mode === 'PRACTICE';
  session = null;
  if (was_practice) {
    return;
  }
  const store = readBattleStore();
  store.进行中 = false;
  store.待决策 = false;
  store.简报 = '';
  store.本回合操作 = [];
  store.局面 = null;
  store.配置 = null;
  store.回放 = { 步骤: [], 起点: null, 已丢弃: 0 };
  writeBattleStore(store);
}

/** 切换「双方操控」开关 (开启后待决策恒为 false, 世界书改注入另一段提示词) */
export async function setControlBothSides(enabled: boolean): Promise<void> {
  const store = readBattleStore();
  store.用户操控双方 = enabled;
  writeBattleStore(store);
  await syncBattle();
}

/**
 * 把当前局面同步到聊天变量.
 *
 * 这是整层的核心: 每次引擎状态变化后都应该调用一次.
 * 只写变量, 不碰世界书 —— 条目由用户手动安装, 靠 `{{if}}` 自己判定是否生效.
 */
export async function syncBattle(): Promise<BattleAIStore> {
  // 演习模式: 连读都不读, 一个字都不写, 保证不会因为变量被世界书条目读到
  if (session?.mode === 'PRACTICE') {
    return BattleAIStoreSchema.parse({});
  }

  const store = readBattleStore();
  const state = session?.state ?? getBattleState();

  if (!state) {
    // 完全空闲时 (从未开战) 不写变量, 避免无意义地污染聊天变量
    if (!store.进行中 && !store.局面) {
      return store;
    }
    store.进行中 = false;
    store.待决策 = false;
    store.简报 = '';
    store.本回合操作 = [];
    writeBattleStore(store);
    return store;
  }

  store.进行中 = !state.finished;
  store.版本 = BATTLE_STORE_VERSION;
  store.回合 = state.turn;
  store.行动方 = state.active;
  // 双方操控时玩家自己把敌方也打了, 不能让 AI 再输出一份决策
  store.待决策 = !state.finished && !store.用户操控双方 && state.active === AI_SIDE;
  store.本回合操作 = recentOps(state);
  store.简报 = state.finished ? '' : briefText(state, AI_SIDE, store.本回合操作);
  // 只把最近一段日志写进变量 (state.log 本身可能很长)
  const recent_log = [...state.log].slice(-BATTLE_SNAPSHOT_LOG_LIMIT);
  store.局面 = { ...state, log: recent_log };
  store.日志 = recent_log.slice(-BATTLE_LOG_LIMIT).map(entry => `T${entry.turn} ${entry.message}`);
  // 回放数据: 步骤 + 起点快照. 步骤超过上限时在这里把更早的部分压进快照
  const replay = compactReplay(toBattleConfig(session.setup), {
    步骤: session.steps,
    起点: session.base,
    已丢弃: session.dropped,
  });
  session.steps = replay.步骤;
  session.base = replay.起点;
  session.dropped = replay.已丢弃;
  store.回放 = { 步骤: replay.步骤.slice(), 起点: replay.起点, 已丢弃: replay.已丢弃 };

  writeBattleStore(store);
  return store;
}

/** 把回放步骤渲染成操作记录行 (简报与日志弹窗都用它) */
function stepsToOps(steps: ReplayStep[]): string[] {
  return steps.map(step => `T${step.回合} ${sideLabel(step.方)} ${step.说明}`);
}

/** 取「本回合 + 上一回合」的操作记录 (更早的对 AI 没有参考价值) */
function recentOps(state: BattleState): string[] {
  const min_turn = Math.max(1, state.turn - 1);
  return stepsToOps(session?.steps ?? []).filter(line => {
    const match = /^T(\d+)/.exec(line);
    return match ? Number(match[1]) >= min_turn : true;
  });
}

/** 给某一方起个显示名 (演习时两边都是玩家) */
function sideLabel(side: PlayerId): string {
  if (session?.mode === 'PRACTICE') {
    return side === HUMAN_SIDE ? '我方' : '敌方';
  }
  return side === HUMAN_SIDE ? '玩家' : 'AI';
}

/**
 * 记一步操作.
 *
 * 回放与操作记录都从它派生 —— 只记一次, 两边不会对不上;
 * 它同时也是「这一步能不能回退」的名单 (带楼层的步骤就是楼层锚点).
 */
function addStep(params: {
  方: PlayerId;
  /** 这一步属于第几回合 —— 必须在调用引擎之前取, 换边后回合号就变了 */
  回合: number;
  来源: 'PLAYER' | 'AI';
  /** AI 决策所在的楼层; 玩家操作没有楼层 */
  楼层?: number | null;
  /** 决策块原文的指纹 */
  指纹?: string;
  说明: string;
  /** 结构化操作 (回放时原样喂回执行器) */
  操作: unknown[];
  /** 执行完是否结束该方行动 */
  结束行动: boolean;
}): void {
  if (!session) {
    return;
  }
  const last = session.steps[session.steps.length - 1];
  session.steps.push({
    序号: (last?.序号 ?? 0) + 1,
    回合: params.回合,
    方: params.方,
    来源: params.来源,
    楼层: params.楼层 ?? null,
    指纹: params.指纹 ?? '',
    说明: params.说明,
    操作: params.操作,
    结束行动: params.结束行动,
  });
}

/** 目标显示名 (卡牌实例 id / 玩家 id 都能处理) */
function targetLabel(state: BattleState, target: string): string {
  if (target === 'PLAYER' || target === 'ENEMY') {
    return `${target === HUMAN_SIDE ? '我方' : '敌方'}玩家`;
  }
  return state.cards[target]?.name ?? target;
}

/** 世界书条目安装状态 (面板可用来提示用户去导入 JSON) */
export function battleWorldbookStatus(): Promise<BattleWorldbookStatus> {
  return checkBattleWorldbook();
}

/** 是否已经提醒过世界书缺失 (只提醒一次, 不刷屏) */
let worldbook_warned = false;

async function warnIfWorldbookMissing(): Promise<void> {
  if (worldbook_warned) {
    return;
  }
  const status = await checkBattleWorldbook();
  if (status.已安装 && status.最新) {
    return;
  }
  worldbook_warned = true;
  console.warn(
    '[卡牌战斗] 未找到最新的世界书条目「[战斗]敌方回合决策」, AI 将收不到决策提示.\n' +
      '请手动导入工作区里的 世界书-卡牌战斗.json (酒馆 → 世界书 → 导入), 并把它绑定为全局/角色/聊天世界书.',
  );
}

// ---------------------------------------------------------------------------
// 操作 (面板调用; 双方通用)
// ---------------------------------------------------------------------------

/**
 * 该方现在能不能操作.
 *
 * - 演习模式: 两边随时都能操作 (自由安排);
 * - 正式战斗: 只能操作当前行动方, 且敌方只有开了「双方操控」才允许操作.
 */
export function canOperate(side: PlayerId): boolean {
  const state = getBattleState();
  if (!state || state.finished) {
    return false;
  }
  if (session?.mode === 'PRACTICE') {
    return true;
  }
  if (state.active !== side) {
    return false;
  }
  if (side === HUMAN_SIDE) {
    return true;
  }
  return readBattleStore().用户操控双方;
}

/** 该方此刻是否有可操作的余地 (给界面灰化按钮用) */
export function isSideBusy(side: PlayerId): boolean {
  return !canOperate(side);
}

function requireOperable(side: PlayerId): BattleState | null {
  return canOperate(side) ? getBattleState() : null;
}

/** 某一方从手牌上场 */
export async function operatePlay(side: PlayerId, card_id: string, slot?: number): Promise<boolean> {
  const state = requireOperable(side);
  if (!state || !canPlayCard(state, card_id)) {
    return false;
  }
  const name = state.cards[card_id]?.name ?? card_id;
  const turn = state.turn;
  const ok = playCard(state, card_id, slot);
  if (ok) {
    addStep({
      方: side,
      回合: turn,
      来源: 'PLAYER',
      说明: `上场「${name}」`,
      操作: [{ do: 'play', card: card_id, slot: slot ?? null }],
      结束行动: false,
    });
  }
  await syncBattle();
  return ok;
}

/** 某一方用场上卡攻击 (target 是卡牌实例 id 或 'PLAYER' / 'ENEMY') */
export async function operateAttack(
  side: PlayerId,
  attacker_id: string,
  target: string,
  answers?: readonly string[],
): Promise<boolean> {
  const state = requireOperable(side);
  if (!state || !canAttack(state, attacker_id)) {
    return false;
  }
  const attacker_name = state.cards[attacker_id]?.name ?? attacker_id;
  const target_name = targetLabel(state, target);
  const turn = state.turn;
  const ok = attack(state, attacker_id, target, { answers });
  if (ok) {
    addStep({
      方: side,
      回合: turn,
      来源: 'PLAYER',
      说明: `「${attacker_name}」攻击 ${target_name}`,
      操作: [{ do: 'attack', card: attacker_id, target, ...(answers === undefined ? {} : { answers: [...answers] }) }],
      结束行动: false,
    });
  }
  await syncBattle();
  return ok;
}

/** 某一方主动发动效果 (effect_id 可以是效果实例 id 或机读区里写的 id) */
export async function operateActivate(
  side: PlayerId,
  card_id: string,
  effect_id: string,
  answers?: readonly string[],
): Promise<boolean> {
  const state = requireOperable(side);
  if (!state) {
    return false;
  }
  const card_name = state.cards[card_id]?.name ?? card_id;
  const label = listActivatable(state, side).find(item => item.card_id === card_id && (item.effect_id === effect_id || item.def_id === effect_id))?.label ?? effect_id;
  const turn = state.turn;
  const ok = activate(state, card_id, effect_id, { answers });
  if (ok) {
    addStep({
      方: side,
      回合: turn,
      来源: 'PLAYER',
      说明: `发动「${card_name}」的技能 ${label}`,
      操作: [
        { do: 'activate', card: card_id, effect: effect_id, ...(answers === undefined ? {} : { answers: [...answers] }) },
      ],
      结束行动: false,
    });
  }
  await syncBattle();
  return ok;
}

/**
 * 某一方回答引擎的询问 (目前主要是手牌超上限时选弃哪张).
 *
 * `card_ids` 就是玩家选中的卡 (要弃的那几张 / 要确认的那几个效果).
 */
export async function operateResolveAsk(side: PlayerId, ask_id: string, card_ids: readonly string[]): Promise<boolean> {
  const state = requireOperable(side);
  if (!state) {
    return false;
  }
  const ask = listAsks(state, side).find(item => item.id === ask_id);
  if (!ask) {
    return false;
  }
  const names = card_ids.map(id => state.cards[id]?.name ?? id);
  const turn = state.turn;
  const ok = resolveAsk(state, ask_id, card_ids);
  if (ok) {
    addStep({
      方: side,
      回合: turn,
      来源: 'PLAYER',
      说明:
        ask.kind === 'DISCARD'
          ? `弃掉「${names.join('」「')}」`
          : `回答「${ask.title}」: ${names.join('、') || ask.options.filter(o => card_ids.includes(o.id)).map(o => o.label).join('、')}`,
      操作: [{ do: `answer`, ask: ask_id, cards: [...card_ids] }],
      结束行动: false,
    });
  }
  await syncBattle();
  return ok;
}

/** 某一方还没回答的询问 (面板据此弹框) */
export function listSideAsks(side: PlayerId): AskRequest[] {
  const state = getBattleState();
  return state ? listAsks(state, side) : [];
}

/** 接下来这次操作里「会先问玩家一句」的效果 (ask: true), 面板据此生成确认框 */
export function listSideAskable(side: PlayerId, timings: EffectTiming[]): AskableEffect[] {
  const state = getBattleState();
  return state ? listAskable(state, side, timings) : [];
}

/** 某一方结束自己的行动 (一个回合里两边各结束一次) */
export async function operateEndTurn(side: PlayerId, answers?: readonly string[]): Promise<void> {
  const state = requireOperable(side);
  if (!state) {
    return;
  }
  addStep({
    方: side,
    回合: state.turn,
    来源: 'PLAYER',
    说明: '结束行动',
    操作: [{ do: 'end', ...(answers === undefined ? {} : { answers: [...answers] }) }],
    结束行动: true,
  });
  endSide(state, side, { answers });
  await syncBattle();
}

// ---------------------------------------------------------------------------
// 演习专用操作 (看牌库 → 直接上场 / 场上卡收回牌库)
// ---------------------------------------------------------------------------

/**
 * 演习模式: 从牌库直接上场.
 *
 * 正式战斗返回 false —— 那时牌库是隐藏信息, 只能看数量.
 */
export async function practicePlayFromDeck(side: PlayerId, card_id: string, slot?: number): Promise<boolean> {
  const state = getBattleState();
  if (session?.mode !== 'PRACTICE' || !state || !canOperate(side)) {
    return false;
  }
  const card = state.cards[card_id];
  if (!card || card.zone !== 'DECK' || !canMoveCardTo(state, card_id, 'FIELD')) {
    return false;
  }
  const ok = moveCardTo(state, card_id, 'FIELD', slot ?? null);
  if (ok) {
    addStep({
      方: side,
      回合: state.turn,
      来源: 'PLAYER',
      说明: `从牌库上场「${card.name}」`,
      操作: [{ do: 'practice-play', card: card_id, slot: slot ?? null }],
      结束行动: false,
    });
  }
  return ok;
}

/** 演习模式: 把场上的卡收回牌库 (下场) */
export async function practiceReturnToDeck(side: PlayerId, card_id: string): Promise<boolean> {
  const state = getBattleState();
  if (session?.mode !== 'PRACTICE' || !state || !canOperate(side)) {
    return false;
  }
  const card = state.cards[card_id];
  if (!card || card.zone !== 'FIELD' || !canMoveCardTo(state, card_id, 'DECK')) {
    return false;
  }
  const ok = moveCardTo(state, card_id, 'DECK', null);
  if (ok) {
    addStep({
      方: side,
      回合: state.turn,
      来源: 'PLAYER',
      说明: `下场「${card.name}」`,
      操作: [{ do: 'practice-return', card: card_id }],
      结束行动: false,
    });
  }
  return ok;
}

// ---------------------------------------------------------------------------
// 兼容包装 (人类玩家 = PLAYER)
// ---------------------------------------------------------------------------

/** 玩家从手牌上场 */
export function playerPlayCard(card_id: string, slot?: number): Promise<boolean> {
  return operatePlay(HUMAN_SIDE, card_id, slot);
}

/** 玩家用场上卡攻击 */
export function playerAttack(attacker_id: string, target: string): Promise<boolean> {
  return operateAttack(HUMAN_SIDE, attacker_id, target);
}

/** 玩家主动发动效果 */
export function playerActivate(card_id: string, effect_id: string): Promise<boolean> {
  return operateActivate(HUMAN_SIDE, card_id, effect_id);
}

/** 玩家结束行动 (两边都结束后才进入回合结算) */
export function playerEndTurn(): Promise<void> {
  return operateEndTurn(HUMAN_SIDE);
}

// ---------------------------------------------------------------------------
// AI 决策
// ---------------------------------------------------------------------------

/** 把一次决策的结果整理成给玩家看的文本 */
export function describeDecisionResult(result: DecisionResult): string {
  if (!result.ok) {
    return `决策被拒绝: ${result.error}`;
  }
  const lines = [
    ...result.applied.map(item => `✔ ${item}`),
    ...result.ignored.map(item => `✖ ${item}`),
  ];
  if (lines.length === 0) {
    lines.push('(没有操作)');
  }
  if (result.finished) {
    lines.push(result.winner ? `战斗结束: ${result.winner} 获胜` : '战斗结束: 平局');
  }
  return lines.join('\n');
}

/**
 * 处理一条 AI 消息: 提取决策 → 应用 → 同步.
 *
 * 没写决策块的消息会被安静忽略 (普通叙事楼层).
 * 演习模式与「双方操控」模式下不结算 —— 这两种情况本来就不该有 AI 决策.
 */
export async function handleBattleMessage(message_id: number): Promise<DecisionResult | null> {
  if (session?.mode === 'PRACTICE' || readBattleStore().用户操控双方) {
    return null;
  }
  const state = getBattleState();
  if (!state || state.finished || state.active !== AI_SIDE) {
    return null;
  }
  const message = getChatMessages(message_id, { role: 'assistant' })[0];
  if (!message) {
    return null;
  }

  const decision = extractDecision(message.message);
  if (!decision.ok) {
    return null;
  }

  const 指纹 = hashText(decision.raw);
  // 同一条决策可能被重复通知 (「重新生成」会先后触发几个事件), 已经结算过就跳过
  if (session?.steps.some(step => step.楼层 === message_id && stepMatchesFingerprint(step, 指纹))) {
    return null;
  }

  const turn = state.turn;
  const result = applyDecision(state, decision, AI_SIDE);
  if (result.ok) {
    addStep({
      方: AI_SIDE,
      回合: turn,
      来源: 'AI',
      楼层: message_id,
      指纹,
      说明: result.applied.join('; ') || '(没有操作)',
      操作: decision.ops ?? [],
      结束行动: result.ended,
    });
  }
  if (session) {
    session.decisions.push({ 步: session.steps.length - 1, 文本: `T${turn} ${describeDecisionResult(result)}` });
    if (session.decisions.length > BATTLE_DECISION_LIMIT) {
      session.decisions = session.decisions.slice(-BATTLE_DECISION_LIMIT);
    }
  }
  const store = readBattleStore();
  store.结果 = describeDecisionResult(result);
  writeBattleStore(store);

  await syncBattle();
  return result;
}

// ---------------------------------------------------------------------------
// 回退 (重新生成 / 切换候补 / 编辑 / 删除楼层 → 把战斗退回去重演)
// ---------------------------------------------------------------------------

/** 触发回退的原因 (会写进提示条, 让用户知道战斗为什么退回去了) */
export type RewindTrigger = '重新生成' | '切换候补' | '编辑消息' | '删除楼层';

/** 楼层里现在装着的决策块指纹 (没有决策块就是空串) */
function messageFingerprint(message_id: number): string {
  const message = getChatMessages(message_id, { role: 'assistant' })[0];
  if (!message) {
    return '';
  }
  const decision = extractDecision(message.message);
  return decision.ok ? hashText(decision.raw) : '';
}

/**
 * 把战斗退回到第 keep 步之前 (静默核心).
 *
 * 退掉的步骤连同它之后的全部作废 —— 旧分支直接丢弃, 不留任何中间状态;
 * 局面由「起点 + 剩下的步骤」重新放出来, 而引擎的随机数由 (种子, 序号) 推导,
 * 所以放出来的局面必然和当初一致, 与手里的局面不同只可能是卡牌库被改过.
 *
 * @param keep 保留多少步 (0 = 全部作废, 回到开局)
 */
async function rewindTo(keep: number): Promise<boolean> {
  if (!session || keep < 0 || keep >= session.steps.length) {
    return false;
  }
  let state: BattleState;
  try {
    state = replayBattle(toBattleConfig(session.setup), { 起点: session.base, 步骤: session.steps, 截止: keep });
  } catch (error) {
    console.error('[卡牌战斗] 回退失败, 战斗保持原样', error);
    return false;
  }
  // 保留的是前缀, 序号不用重排
  session.steps = session.steps.slice(0, keep);
  session.state = state;
  session.decisions = session.decisions.filter(item => item.步 < keep);
  await syncBattle();
  return true;
}

/**
 * 某个楼层变了 (重新生成 / 切换候补 / 编辑) 时把战斗退回到它之前.
 *
 * 楼层里装着的还是当初那个决策时不动 —— 否则同一楼层被通知多次就会退多次.
 *
 * @returns 是否真的回退了
 */
export async function rewindForMessage(message_id: number, trigger: RewindTrigger): Promise<boolean> {
  if (session?.mode !== 'BATTLE') {
    return false;
  }
  const keep = rewindCountFor(session.steps, message_id);
  if (keep < 0) {
    return false;
  }
  const step = session.steps[keep];
  if (step && stepMatchesFingerprint(step, messageFingerprint(message_id))) {
    return false;
  }
  const turn = step?.回合 ?? session.state.turn;
  const side = step ? sideLabel(step.方) : '';
  if (!(await rewindTo(keep))) {
    return false;
  }
  notify({
    title: '战斗已回退',
    message: `检测到「${trigger}」(楼层 #${message_id}), 战斗已退回 T${turn} ${side}行动之前, 请重新进行本轮操作.`,
    level: 'warning',
  });
  return true;
}

/** 楼层变了: 先回退这一轮, 再按楼层里的新内容重新结算 */
async function onFloorChanged(message_id: number, trigger: RewindTrigger): Promise<void> {
  await rewindForMessage(message_id, trigger);
  await handleBattleMessage(message_id);
}

/**
 * 手动回溯到第 keep 步之前 (面板「回溯」用).
 *
 * 与楼层触发的回退是同一套机制, 只是由用户点名; 已结束的战斗也能借此退回去继续打.
 */
export async function rewindToStep(keep: number): Promise<boolean> {
  if (!session || session.mode !== 'BATTLE') {
    notify({
      title: '暂时不能回溯',
      message: '只有正式战斗才能回退 (演习本来就不写变量, 直接重开一份就行).',
      level: 'warning',
    });
    return false;
  }
  const total = session.steps.length;
  if (keep < 0 || keep >= total) {
    return false;
  }
  const dropped = total - keep;
  if (!(await rewindTo(keep))) {
    return false;
  }
  notify({
    title: '战斗已回退',
    message: `已退掉 ${dropped} 步, 现在轮到 T${session.state.turn} ${sideLabel(session.state.active)} 行动, 请重新进行操作.`,
    level: 'warning',
  });
  return true;
}

/** 楼层被删除: 该楼层的决策连同之后的一起作废, 其余锚点整体前移 */
async function onMessageDeleted(message_id: number): Promise<void> {
  if (session?.mode !== 'BATTLE') {
    return;
  }
  const keep = rewindCountFor(session.steps, message_id);
  if (keep >= 0 && (await rewindTo(keep))) {
    notify({
      title: '战斗已回退',
      message: `楼层 #${message_id} 已被删除, 战斗连同之后的操作一起退回了, 请重新进行本轮操作.`,
      level: 'warning',
    });
  }
  // 酒馆的消息 id 是下标, 删掉一层之后所有锚点都要前移, 否则以后会认错楼层
  if (session.steps.some(step => step.楼层 !== null && step.楼层 > message_id)) {
    shiftAnchorsAfterDelete(session.steps, message_id);
    await syncBattle();
  }
}

/** 监听句柄 (同一脚本生命周期内只装一次; 脚本卸载时酒馆助手会自动清理) */
let listener_handles: EventOnReturn[] = [];

/** 安装楼层监听: AI 回复后自动结算, 楼层变动后自动回退重演 */
export function installBattleDecisionListener(): EventOnReturn[] {
  if (listener_handles.length > 0) {
    return listener_handles;
  }
  listener_handles = [
    // 重新生成 / 切换候补: 先把战斗退回本轮之前, 再结算新决策
    eventOn(tavern_events.MESSAGE_RECEIVED, (message_id: number, type?: string) => {
      if (type === 'regenerate' || type === 'swipe') {
        void onFloorChanged(message_id, type === 'swipe' ? '切换候补' : '重新生成');
        return;
      }
      void handleBattleMessage(message_id);
    }),
    // 有的酒馆版本只发 SWIPED; 重复触发会被「指纹一致就不动」挡下来
    eventOn(tavern_events.MESSAGE_SWIPED, (message_id: number) => {
      void onFloorChanged(message_id, '切换候补');
    }),
    eventOn(tavern_events.MESSAGE_EDITED, (message_id: number) => {
      void onFloorChanged(message_id, '编辑消息');
    }),
    eventOn(tavern_events.MESSAGE_DELETED, (message_id: number) => {
      void onMessageDeleted(message_id);
    }),
  ];
  return listener_handles;
}

/** 回放体检报告的缓存 (重放一遍不便宜, 没必要每秒算一遍) */
let replay_report_cache: { key: string; report: ReplayReport } | null = null;

/**
 * 回放体检报告 (战斗调试面板展示用).
 *
 * 会把回放数据整体重放一遍与当前局面比对 —— 不一致说明卡牌库被改过,
 * 回退仍然可用, 但退出来的局面会与当初不同.
 *
 * 面板每秒刷新一次, 所以结果缓存一份: 只要步骤与随机数序号都没变就复用.
 */
export function battleReplayReport(): ReplayReport | null {
  const store = readBattleStore();
  const setup = session?.setup ?? (store.配置 ? BattleSetupSchema.parse(store.配置) : null);
  if (!setup) {
    return null;
  }
  const last = session?.steps[session.steps.length - 1];
  const key = [
    session?.mode ?? '-',
    session?.steps.length ?? store.回放.步骤.length,
    last?.序号 ?? 0,
    last?.说明 ?? '',
    session?.base ? 'B' : '-',
    session?.state.counters.__rng ?? -1,
  ].join('|');
  if (replay_report_cache?.key === key) {
    return replay_report_cache.report;
  }
  const report = inspectReplay(toBattleConfig(setup), store.回放, getBattleState());
  replay_report_cache = { key, report };
  return report;
}

/**
 * 现在轮到 AI 时, 主动触发一次生成 (让 AI 给出决策).
 *
 * 默认不会被自动调用: 需要面板上的「让 AI 行动」按钮或用户手动触发.
 */
export async function requestAIDecision(): Promise<boolean> {
  if (!isBattleWaitingForAI()) {
    return false;
  }
  await syncBattle();
  try {
    await triggerSlash('/trigger');
    return true;
  } catch (error) {
    console.error('[卡牌战斗] 触发 AI 生成失败', error);
    return false;
  }
}

/**
 * 一步到位: 恢复会话 + 安装监听 + 同步.
 *
 * 面板接入时在脚本入口调用一次即可.
 */
export async function installBattleBridge(): Promise<void> {
  installBattleDecisionListener();
  try {
    await syncBattle();
  } catch (error) {
    // 还没进入对话时聊天变量不可用, 这里不该打断脚本加载
    console.warn('[卡牌战斗] 初始化同步失败 (可能还没进入对话):', error);
  }
}
