// 战斗 · 世界书条目 (手动安装, 不自动注入)
//
// 本模块只负责「生成」条目内容和可导入的文件, 不会在开战时自动改写用户的世界书.
// 安装方式二选一:
//   1. 酒馆「世界书」界面导入 世界书-卡牌战斗.json (由 生成世界书.ts 生成);
//   2. 手动新建条目, 把 battleEntryContent() 的文本粘进去 (见 AI战斗协议.md).
// installBattleWorldbook() 是给「面板上一个明确的安装按钮」预留的, 默认流程不调用它.
//
// 条目内容:
//
//   {{if {{get_chat_variable::战斗.AI.待决策}}}}
//   <固定协议文本, 由 协议.ts 生成>
//   {{/if}}
//   {{if {{get_chat_variable::战斗.AI.用户操控双方}}}}
//   <双方操控提示词, 由 协议.ts 生成>
//   {{/if}}
//   {{if {{get_chat_variable::战斗.AI.进行中}}}}
//   【本回合简报】
//   {{format_chat_variable::战斗.AI.简报}}
//   {{/if}}
//
// 三段各自独立判定:
// - 轮到 AI 决策 → 注入决策协议;
// - 玩家同时操控两边 → 只注入「不要输出决策」的说明 (否则 AI 会和玩家抢着行动);
// - 战斗进行中 → 注入当前局面简报 (含玩家操作记录与已有效果).
//
// 为什么这样写
// - 蓝灯 (constant) + 深度 0 系统消息: 稳定地作为系统命令出现在提示词里;
// - 条件判定用 `{{if}}` 包住整条内容: 不在战斗中 / 不需要 AI 决策时渲染为空, 不占上下文;
//   (酒馆官方宏文档明确支持 `{{if {{getvar::x}}}}` 这种嵌套写法, 假值包括空串 / false / 0 / off / no)
// - 数据用 `{{format_chat_variable::}}` 而不是 `{{get_chat_variable::}}`:
//     get_ 的结果等于 JSON.stringify, 多行文本里的换行会变成 `\n` 转义;
//     format_ 的结果等于 YAML.stringify, 多行文本会变成 YAML 块标量, 换行保留且 AI 更好读;
// - 条目可以常驻 (装在全局/角色世界书里都行) 也不会污染别的对话, 因为 `{{if}}` 判的是当前聊天的变量;
// - 协议文本写在条目里而不是变量里, 方便在世界书编辑器里直接查看/微调.

import { BRIEF_HEADING, PROTOCOL_VERSION, bothSidesNote, protocolText } from './协议.ts';
import { BATTLE_AI_PATH } from './schema.ts';

/** 建议的世界书名称 (导入 JSON 时会创建同名世界书) */
export const BATTLE_WORLDBOOK_NAME = '卡牌战斗';

/** 条目名称 */
export const BATTLE_ENTRY_NAME = '[战斗]敌方回合决策';

/** 条目内容 (条件判定 + 协议 / 双方操控说明 + 变量读取) */
export function battleEntryContent(): string {
  return [
    `{{if {{get_chat_variable::${BATTLE_AI_PATH}.待决策}}}}`,
    protocolText(),
    '{{/if}}',
    `{{if {{get_chat_variable::${BATTLE_AI_PATH}.用户操控双方}}}}`,
    bothSidesNote(),
    '{{/if}}',
    `{{if {{get_chat_variable::${BATTLE_AI_PATH}.进行中}}}}`,
    BRIEF_HEADING,
    `{{format_chat_variable::${BATTLE_AI_PATH}.简报}}`,
    '{{/if}}',
  ].join('\n');
}

/** 酒馆助手格式的条目 (uid 用 0, 写入时由酒馆重新分配) */
export function battleWorldbookEntry(): WorldbookEntry {
  return {
    uid: 0,
    name: BATTLE_ENTRY_NAME,
    enabled: true,
    strategy: {
      type: 'constant',
      keys: [],
      keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    },
    position: { type: 'at_depth', role: 'system', depth: 0, order: 100 },
    content: battleEntryContent(),
    probability: 100,
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
    effect: { sticky: null, cooldown: null, delay: null },
  };
}

/** 酒馆原生格式的条目 (酒馆导入/导出世界书时用的字段名) */
export function battleTavernEntry(index = 0): Record<string, unknown> {
  const entry = battleWorldbookEntry();
  return {
    uid: index,
    displayIndex: index,
    comment: entry.name,
    disable: !entry.enabled,
    constant: entry.strategy.type === 'constant',
    selective: entry.strategy.type === 'selective',
    vectorized: entry.strategy.type === 'vectorized',
    key: entry.strategy.keys,
    keysecondary: entry.strategy.keys_secondary.keys,
    selectiveLogic: { and_any: 0, not_all: 1, not_any: 2, and_all: 3 }[entry.strategy.keys_secondary.logic],
    scanDepth: entry.strategy.scan_depth === 'same_as_global' ? null : entry.strategy.scan_depth,
    position: {
      before_character_definition: 0,
      after_character_definition: 1,
      before_example_messages: 5,
      after_example_messages: 6,
      before_author_note: 2,
      after_author_note: 3,
      at_depth: 4,
      outlet: 7,
    }[entry.position.type],
    role: { system: 0, user: 1, assistant: 2 }[entry.position.role],
    depth: entry.position.depth,
    order: entry.position.order,
    content: entry.content,
    useProbability: true,
    probability: entry.probability,
    excludeRecursion: entry.recursion.prevent_incoming,
    preventRecursion: entry.recursion.prevent_outgoing,
    delayUntilRecursion: entry.recursion.delay_until ?? false,
    sticky: entry.effect.sticky,
    cooldown: entry.effect.cooldown,
    delay: entry.effect.delay,
    addMemo: true,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
  };
}

/** 可直接另存为 .json 并导入酒馆的世界书文件内容 */
export function battleWorldbookFile(): { entries: Record<string, Record<string, unknown>> } {
  return { entries: { 0: battleTavernEntry(0) } };
}

/**
 * 手动安装: 把条目写进指定世界书 (不传则用当前聊天的世界书).
 *
 * 这是「明确的用户操作」, 默认流程不要自动调用; 已存在同名条目时会被替换为最新内容.
 *
 * @returns 实际写入的世界书名称
 */
export async function installBattleWorldbook(worldbook_name?: string): Promise<string> {
  const target = worldbook_name ?? (await getOrCreateChatWorldbook('current', BATTLE_WORLDBOOK_NAME));
  const existing = await getWorldbook(target).catch(() => [] as WorldbookEntry[]);
  const others = existing.filter(entry => entry.name !== BATTLE_ENTRY_NAME);
  await createOrReplaceWorldbook(target, [...others, battleWorldbookEntry()]);
  return target;
}

/** 条目安装状态 (面板可用来提示用户去导入 JSON) */
export interface BattleWorldbookStatus {
  /** 是否至少在一个世界书里找到条目 */
  已安装: boolean;
  /** 找到的条目内容是否与当前协议一致 */
  最新: boolean;
  /** 找到条目的世界书名称 */
  所在世界书: string[];
}

/** 只读检查所有世界书, 找出条目装在哪、是否需要更新 */
export async function checkBattleWorldbook(): Promise<BattleWorldbookStatus> {
  const expected = battleEntryContent();
  const found: string[] = [];
  let latest = false;

  for (const name of getWorldbookNames()) {
    let entries: WorldbookEntry[];
    try {
      entries = await getWorldbook(name);
    } catch {
      continue;
    }
    const hit = entries.find(entry => entry.name === BATTLE_ENTRY_NAME);
    if (!hit) {
      continue;
    }
    found.push(name);
    if (hit.content === expected) {
      latest = true;
    }
  }

  return { 已安装: found.length > 0, 最新: latest, 所在世界书: found };
}

export { PROTOCOL_VERSION };
