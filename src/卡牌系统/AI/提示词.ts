// 写卡 AI - 提示词 (规范文本 + 任务说明) 的查看与自定义
//
// 这些提示词原本写死在 规范.ts 与 任务.ts 里, 用户只能当黑箱用.
// 这里把它们整理成若干「条目」, 每一条都能:
//   - 查看当前真正发给 AI 的文本 (包含被改过的版本)
//   - 单独改成自己的版本 (改坏了能一键恢复默认)
//
// 自定义的结果存在「脚本变量」里, 与对话、角色卡无关; 与接口设置 (设置.ts) 也互不干扰.
//
// 注意: 机读规范与卡牌规范是引擎能力的说明书, 删掉会导致生成的 machine_effect
// 通不过校验. 界面会标出哪些条目是「关键」, 但不会禁止修改 —— 用户自己说了算.

import { 卡牌写作规范, 输出约定, 机读规范, 用户优先规范 } from './规范.ts';

/** 可查看 / 可自定义的提示词条目键名 */
export const PROMPT_KEYS = ['用户优先', '卡牌规范', '机读规范', '输出约定', '卡牌任务', '卡组任务', '机读任务'] as const;

export type PromptKey = (typeof PROMPT_KEYS)[number];

export interface PromptEntry {
  key: PromptKey;
  标题: string;
  说明: string;
  /** 默认文本 (用户的修改会临时顶掉它) */
  默认: string;
  /** 关键条目: 改了很容易让 AI 产出对不上引擎的东西 */
  关键?: boolean;
}

/** 「生成一张卡」的任务说明 (阵营与需求走 context, 不在这里) */
const 卡牌任务默认 = `【任务】按用户需求设计一张卡牌.

用户提的要求就是最高优先级 (强度、机制、风格都算), 不要用「平衡」之类的理由打回去, 也不要中途再减一点.

自然语言描述 (description) 与机读效果 (machine_effect) 必须表达同一件事, 且机读效果能通过语法校验.

输出格式 (键名必须完全一致, 不要换成中文键名, 也不要再套一层 card 外壳):
{"name":"卡名","series":"","rarity":"N","stars":1,"type":"从者","attribute":"","gender":"","race":"","height":"","atk":"300","shield":"300","hp":"1500","energy":"2","description":"效果描述","machine_effect":{}}

只输出卡牌 JSON 对象, 不要输出卡组或数组.`;

/** 「生成卡组」的任务说明 (占位符见 渲染模板) */
const 卡组任务默认 = `【任务】为一场卡牌战斗设计「{{阵营}}」卡组.
【生成的卡牌阵营】{{卡牌阵营}}

卡牌列表中每一项的「数量」表示携带几份, 本次{{方式}}总张数控制在 {{张数}} 张左右.

上下文里的卡牌列表用「×N」表示携带 N 份; 你输出时同样用「数量」字段表示份数, 不要把同一张卡重复写成多条.

输出格式 (键名必须完全一致, 不要用 cards / quantity 之类的英文键):
{"名称":"卡组名","备注":"一句话设计思路","卡牌":[{"name":"卡名","series":"","rarity":"N","stars":1,"type":"从者","attribute":"","gender":"","race":"","height":"","atk":"300","shield":"300","hp":"1500","energy":"2","description":"效果描述","machine_effect":{},"数量":1}]}

只输出卡组 JSON 对象.`;

/** 「写机读」的任务说明 */
const 机读任务默认 = `【任务】把下面这张卡的自然语言效果描述翻译成机读效果对象.

只翻译描述里明确写到的效果, 不要自行加强或补充.

每条效果都要写 id: 拿描述里那个技能名 (如 "医疗指令"); 描述里没给名字就根据它干的事起个短名 (如 "burn").
同名效果要保证真的同名, 不同效果不要重名.

但「作者补充说明」是用户自己的要求, 与描述冲突时以补充说明为准.

输出格式: {"machine_effect": {...}, "ignored": ["无法表达的效果"]}`;

/** 全部条目 (顺序 = 发给 AI 的顺序) */
export const PROMPT_ENTRIES: readonly PromptEntry[] = [
  {
    key: '用户优先',
    标题: '第一原则: 用户说了算',
    说明: '每次请求都排在最前面的开场白, 用来压住模型「自动平衡数值」的倾向。',
    默认: 用户优先规范,
  },
  {
    key: '卡牌规范',
    标题: '卡牌字段与数值规范',
    说明: '卡面字段怎么写、数值给什么档位。想让所有卡都强一档, 改这里最直接。',
    默认: 卡牌写作规范,
  },
  {
    key: '机读规范',
    标题: '机读效果语法',
    说明: '引擎能听懂的效果写法。删掉或改错会让生成的卡失去效果。',
    默认: 机读规范,
    关键: true,
  },
  {
    key: '输出约定',
    标题: '输出格式约定',
    说明: '要求模型只回一个能被解析的 JSON。',
    默认: 输出约定,
  },
  {
    key: '卡牌任务',
    标题: '任务说明: 生成一张卡',
    说明: '「生成卡牌」时下达的具体指令, 含输出格式样例。',
    默认: 卡牌任务默认,
    关键: true,
  },
  {
    key: '卡组任务',
    标题: '任务说明: 生成卡组',
    说明: '「生成卡组」时下达的具体指令。可用占位符: {{阵营}} {{卡牌阵营}} {{方式}} {{张数}}。',
    默认: 卡组任务默认,
    关键: true,
  },
  {
    key: '机读任务',
    标题: '任务说明: 写机读',
    说明: '「AI 写机读」时下达的具体指令。',
    默认: 机读任务默认,
    关键: true,
  },
];

/** 覆盖项在脚本变量里的键名 */
export const PROMPT_STORE_KEY = '写卡AI提示词';

/** 每条自定义文本的长度上限 (防止误粘一整篇论文进来) */
export const PROMPT_TEXT_LIMIT = 20000;

/** 内存里的覆盖 (load 之后是最新的; 未设置的条目走默认值) */
let overrides: Partial<Record<PromptKey, string>> = {};
let loaded = false;

const listeners = new Set<() => void>();

/** 脚本变量是否可用 (node 测试环境下没有) */
function hasScriptVariables(): boolean {
  return typeof getVariables === 'function' && typeof getScriptId === 'function';
}

function isKey(value: string): value is PromptKey {
  return (PROMPT_KEYS as readonly string[]).includes(value);
}

/** 把外部数据规整成覆盖表: 只收已知键 + 非空字符串 */
function normalize(raw: unknown): Partial<Record<PromptKey, string>> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const result: Partial<Record<PromptKey, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isKey(key) && typeof value === 'string' && value.trim()) {
      result[key] = value.slice(0, PROMPT_TEXT_LIMIT);
    }
  }
  return result;
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 忽略: 单个订阅者出错不影响其他界面 */
    }
  }
}

/** 订阅提示词变化 (同一份脚本里的多个面板共享同一个模块实例) */
export function onPromptsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 从脚本变量读一次 (界面打开时调用; 读不到就保持默认) */
export function loadPromptOverrides(): void {
  loaded = true;
  if (!hasScriptVariables()) {
    return;
  }
  try {
    const store = getVariables({ type: 'script', script_id: getScriptId() });
    overrides = normalize(store?.[PROMPT_STORE_KEY]);
  } catch {
    overrides = {};
  }
  notify();
}

/** 当前覆盖表 (副本) */
export function promptOverrides(): Partial<Record<PromptKey, string>> {
  return { ...overrides };
}

/**
 * 直接换掉内存里的覆盖表 (不写变量).
 *
 * 界面用 savePromptOverrides; 测试与「先看效果再决定要不要存」的场景用这个.
 */
export function applyPromptOverrides(next: unknown): void {
  loaded = true;
  overrides = normalize(next);
  notify();
}

/** 保存覆盖表 (写脚本变量; 没填的条目 = 用默认值) */
export function savePromptOverrides(next: unknown): Partial<Record<PromptKey, string>> {
  overrides = normalize(next);
  loaded = true;
  if (typeof insertOrAssignVariables === 'function' && typeof getScriptId === 'function') {
    insertOrAssignVariables({ [PROMPT_STORE_KEY]: { ...overrides } }, { type: 'script', script_id: getScriptId() });
  }
  notify();
  return { ...overrides };
}

/** 全部恢复默认 (清掉变量里的覆盖) */
export function clearPromptOverrides(): void {
  savePromptOverrides({});
}

/** 这一条被改过吗 */
export function isPromptCustomized(key: PromptKey): boolean {
  return typeof overrides[key] === 'string';
}

/** 拿某一条的默认文本 */
export function promptDefault(key: PromptKey): string {
  return PROMPT_ENTRIES.find(entry => entry.key === key)?.默认 ?? '';
}

/** 把模板里的 {{占位符}} 换成实际值 (没给值的占位符清成空串) */
export function 渲染模板(text: string, values: Record<string, string | number> = {}): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, name: string) => {
    const value = values[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * 拿某一条当前实际使用的文本.
 *
 * 第一次调用时会自动从脚本变量读一遍, 所以调用方不用记得先 load.
 */
export function promptText(key: PromptKey): string {
  if (!loaded) {
    loadPromptOverrides();
  }
  return overrides[key] ?? promptDefault(key);
}

/**
 * 拿某一条并顺手把占位符填好 (只有卡组任务用得上).
 */
export function promptTextFilled(key: PromptKey, values: Record<string, string | number> = {}): string {
  return 渲染模板(promptText(key), values);
}
