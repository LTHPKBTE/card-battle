// AI 辅助写卡 - 生成请求客户端
//
// 用酒馆助手的 `generateRaw` 直接发起一次独立请求:
//  - 不使用当前预设, 也不注入世界书 (ordered_prompts 里没有 world_info_*)
//  - 默认不带聊天历史 (max_chat_history: 0), 需要上下文的任务再显式打开
//  - 静默生成, 不会在聊天里留楼层, 也不影响酒馆的发送/停止按钮
//  - 接口由 `设置.ts` 决定: 默认用酒馆当前接口, 也可以改用另一个预设或自定义 OAI 接口
//
// 这样 AI 写卡与「聊天里的 AI」互不干扰, 也不依赖任何注入是否生效.

import { aiSettingsIssue, loadAiSettings, toCustomApi } from './设置.ts';
import { parseAiJson } from './解析.ts';

/** 一次生成请求 */
export interface AiRequest {
  /** 任务提示词 (放在最后一条 user 消息) */
  prompt: string;
  /** 系统提示词 (规范、写作要求) */
  system?: string;
  /** 附加上下文 (卡面信息、卡组摘要等), 会作为一条 user 消息放在 prompt 之前 */
  context?: string;
  /** 是否携带聊天历史 (生成卡组时需要; 写机读时不需要, 生成单卡由用户选择) */
  with_history?: boolean;
  /** 携带聊天历史时的最大条数, 默认 24 */
  max_chat_history?: number;
  /** 传入后会要求模型输出符合该 schema 的 JSON */
  json_schema?: JsonSchema;
  /** 覆盖接口设置 (一般不用传, 默认读「写卡 AI 设置」) */
  custom_api?: CustomApiConfig;
}

/** 当前环境是否支持直接生成 (酒馆助手版本过旧时为 false) */
export function isAiAvailable(): boolean {
  return typeof generateRaw === 'function';
}

let counter = 0;
/** 正在进行的生成请求 id, 用于精确中断 */
const active_ids = new Set<string>();

function newGenerationId(): string {
  counter += 1;
  return `card-ai-${Date.now().toString(36)}-${counter}`;
}

/** 发起一次独立生成, 返回模型的文本输出 */
export async function aiGenerate(request: AiRequest): Promise<string> {
  if (!isAiAvailable()) {
    throw new Error('当前酒馆助手版本不支持 generateRaw, 请升级酒馆助手');
  }

  // 接口设置不完整时直接报错, 避免静默回退到「当前接口」让用户以为设置生效了
  const settings = loadAiSettings();
  const issue = aiSettingsIssue(settings);
  if (issue) {
    throw new Error(issue);
  }
  const custom_api = request.custom_api ?? toCustomApi(settings);

  const ordered_prompts: (PlaceholderPrompt | RolePrompt)[] = [];
  if (request.with_history) {
    ordered_prompts.push('chat_history');
  }
  if (request.system) {
    ordered_prompts.push({ role: 'system', content: request.system });
  }
  if (request.context) {
    ordered_prompts.push({ role: 'user', content: request.context });
  }
  ordered_prompts.push({ role: 'user', content: request.prompt });

  const generation_id = newGenerationId();
  active_ids.add(generation_id);
  try {
    const raw = await generateRaw({
      ordered_prompts,
      should_silence: true,
      should_stream: false,
      max_chat_history: request.with_history ? (request.max_chat_history ?? 24) : 0,
      generation_id,
      ...(custom_api ? { custom_api } : {}),
      ...(request.json_schema ? { json_schema: request.json_schema } : {}),
    });
    const text = typeof raw === 'string' ? raw : raw.content;
    if (!text.trim()) {
      throw new Error('AI 没有返回内容');
    }
    return text;
  } catch (error) {
    throw new Error(`AI 生成失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    active_ids.delete(generation_id);
  }
}

/**
 * 发起一次生成并要求 JSON 输出.
 *
 * 先带 `json_schema` 请求一次; 若请求失败或返回内容无法解析成 JSON,
 * 则去掉 `json_schema` 再试一次 (兼容不支持结构化输出的模型/接口).
 */
export async function aiGenerateJson<T = unknown>(request: AiRequest): Promise<T> {
  const schema = request.json_schema;

  async function attempt(use_schema: boolean): Promise<T> {
    const text = await aiGenerate({
      ...request,
      json_schema: use_schema ? schema : undefined,
    });
    return parseAiJson(text) as T;
  }

  try {
    return await attempt(true);
  } catch (error) {
    if (!schema) {
      throw error;
    }
    console.warn('[卡牌AI] 结构化输出失败, 改用普通输出重试:', error);
    return await attempt(false);
  }
}

/** 中断当前所有由本模块发起的生成请求, 返回成功中断的数量 */
export function aiStopAll(): number {
  let stopped = 0;
  for (const generation_id of active_ids) {
    try {
      if (typeof stopGenerationById === 'function' && stopGenerationById(generation_id)) {
        stopped += 1;
      }
    } catch {
      /* 忽略: 单个请求中断失败不影响其余请求 */
    }
  }
  return stopped;
}
