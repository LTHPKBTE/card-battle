// 写卡 AI - 接口设置
//
// 写卡相关的三个功能 (AI 写机读 / AI 生成卡牌 / AI 生成卡组) 默认都用
// 「酒馆当前选中的接口与模型」, 但也可以换成:
//   - 预设: 酒馆里已保存的另一个代理预设 (地址与密钥都跟着预设走)
//   - 自定义: 直接填一个 OAI 兼容接口 (地址 / 密钥 / 模型 / 接口类型)
//
// 设置存在「脚本变量」里, 与当前对话、角色卡无关, 换聊天也不会丢.

import { z } from 'zod';

/** 接口模式 */
export const AI_MODES = ['当前', '预设', '自定义'] as const;
export type AiMode = (typeof AI_MODES)[number];

/** 各模式的说明 (界面用) */
export const AI_MODE_HINTS: Record<AiMode, string> = {
  当前: '用酒馆当前选中的接口与模型, 不做任何覆盖',
  预设: '用酒馆里已保存的另一个代理预设 (地址与密钥都跟预设走)',
  自定义: '直接填一个 OAI 兼容接口的地址与密钥',
};

/** 常见接口类型 (仅供界面快捷选择, 不限制自由输入) */
export const AI_SOURCE_CHOICES = [
  'openai',
  'claude',
  'makersuite',
  'vertexai',
  'deepseek',
  'mistralai',
  'groq',
  'openrouter',
  'xai',
  'moonshot',
  'cohere',
  'perplexity',
  'custom',
] as const;

/** 设置在脚本变量中的键名 */
export const AI_SETTINGS_KEY = '写卡AI设置';

/** 写卡 AI 接口设置 */
export const AiSettingsSchema = z.object({
  /** 接口模式: 当前 / 预设 / 自定义 */
  模式: z.enum(AI_MODES).prefault('当前'),

  /** 模式为「预设」时使用的酒馆代理预设名 */
  预设名: z.string().prefault(''),

  /** 模式为「自定义」时的接口地址 (OAI 兼容, 一般以 /v1 结尾) */
  接口地址: z.string().prefault(''),

  /** 模式为「自定义」时的密钥 */
  密钥: z.string().prefault(''),

  /** 模型名; 留空表示用接口默认模型 */
  模型: z.string().prefault(''),

  /** 接口类型 (openai / claude / deepseek ...), 留空按 openai 处理 */
  接口类型: z.string().prefault('openai'),

  /** 温度, null 表示用接口默认值 */
  温度: z.number().min(0).max(2).nullable().default(null),

  /** 最大回复长度, null 表示用接口默认值 */
  最大回复长度: z.number().int().min(1).nullable().default(null),
});

export type AiSettings = z.infer<typeof AiSettingsSchema>;

/** 默认设置: 用酒馆当前接口 */
export function defaultAiSettings(): AiSettings {
  return AiSettingsSchema.parse({});
}

/** 脚本变量是否可用 (node 测试环境下没有) */
function hasScriptVariables(): boolean {
  return typeof getVariables === 'function' && typeof getScriptId === 'function';
}

/** 设置变化时的订阅者 (同一份脚本里的多个面板共享同一个模块实例) */
const listeners = new Set<() => void>();

/** 订阅设置变化, 返回取消订阅的函数 */
export function onAiSettingsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 读取写卡 AI 设置 (读不到或结构不对时回退到默认值) */
export function loadAiSettings(): AiSettings {
  if (!hasScriptVariables()) {
    return defaultAiSettings();
  }
  try {
    const store = getVariables({ type: 'script', script_id: getScriptId() });
    const parsed = AiSettingsSchema.safeParse(store?.[AI_SETTINGS_KEY]);
    return parsed.success ? parsed.data : defaultAiSettings();
  } catch {
    return defaultAiSettings();
  }
}

/** 保存写卡 AI 设置, 返回规范化后的结果 */
export function saveAiSettings(settings: AiSettings): AiSettings {
  const parsed = AiSettingsSchema.parse(settings);
  if (typeof insertOrAssignVariables === 'function' && typeof getScriptId === 'function') {
    insertOrAssignVariables({ [AI_SETTINGS_KEY]: parsed }, { type: 'script', script_id: getScriptId() });
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* 忽略: 单个订阅者出错不影响保存 */
    }
  }
  return parsed;
}

/** 从地址里取一个便于辨认的短标签 */
function hostOf(apiurl: string): string {
  const text = apiurl.trim();
  if (!text) {
    return '';
  }
  try {
    return new URL(text).host || text;
  } catch {
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }
}

/** 当前设置指向哪个接口 (界面上的灰色小字用) */
export function describeAiSettings(settings: AiSettings): string {
  if (settings.模式 === '预设') {
    const preset = settings.预设名.trim();
    return preset ? `酒馆预设「${preset}」` : '酒馆预设 (未选择)';
  }
  if (settings.模式 === '自定义') {
    const host = hostOf(settings.接口地址);
    return host ? `自定义接口 ${host}` : '自定义接口 (未填地址)';
  }
  return '酒馆当前接口';
}

/** 设置是否填完整; 返回空串表示可用 */
export function aiSettingsIssue(settings: AiSettings): string {
  if (settings.模式 === '预设' && !settings.预设名.trim()) {
    return '写卡 AI 选择了「预设」, 但还没有选预设名';
  }
  if (settings.模式 === '自定义' && !settings.接口地址.trim()) {
    return '写卡 AI 选择了「自定义」, 但还没有填接口地址';
  }
  return '';
}

/**
 * 把设置转成 `generateRaw` 的 `custom_api`.
 *
 * 「当前」模式且没有覆盖参数时返回 undefined, 表示完全用酒馆当前接口.
 */
export function toCustomApi(settings: AiSettings): CustomApiConfig | undefined {
  const api: CustomApiConfig = {};
  if (settings.温度 !== null) {
    api.temperature = settings.温度;
  }
  if (settings.最大回复长度 !== null) {
    api.max_tokens = settings.最大回复长度;
  }

  if (settings.模式 === '预设') {
    const preset = settings.预设名.trim();
    if (!preset) {
      return undefined;
    }
    api.proxy_preset = preset;
  } else if (settings.模式 === '自定义') {
    const apiurl = settings.接口地址.trim();
    if (!apiurl) {
      return undefined;
    }
    api.apiurl = apiurl;
    const key = settings.密钥.trim();
    if (key) {
      api.key = key;
    }
    api.source = settings.接口类型.trim() || 'openai';
  }

  const model = settings.模型.trim();
  if (model) {
    api.model = model;
  }

  return Object.keys(api).length > 0 ? api : undefined;
}

/** 拉取酒馆里保存的代理预设名 (取不到时返回空数组) */
export function listProxyPresets(): string[] {
  if (typeof getProxyPresetNames !== 'function') {
    return [];
  }
  try {
    return getProxyPresetNames().filter(name => typeof name === 'string' && name.trim() !== '');
  } catch {
    return [];
  }
}

/** 拉取某个自定义接口的模型列表 */
export async function listModels(apiurl: string, key = ''): Promise<string[]> {
  const url = apiurl.trim();
  if (!url) {
    throw new Error('请先填写接口地址');
  }
  if (typeof getModelList !== 'function') {
    throw new Error('当前酒馆助手版本不支持获取模型列表');
  }
  const models = await getModelList(key.trim() ? { apiurl: url, key: key.trim() } : { apiurl: url });
  return models.filter(name => typeof name === 'string' && name.trim() !== '');
}
