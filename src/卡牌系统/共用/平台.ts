// 酒馆运行环境相关的几个小工具: 挂载点、样式搬运、切聊天重载, 以及 id 生成与文本解析.
//
// 这份代码为什么要自己写:
// 参考仓库 `tavern_helper_template` 采用 Aladdin Free Public License (AFPL) —— 它自己声明
// 「不是开源许可证」, 要求衍生作品**整体**以 AFPL 授权, 且禁止涉及付款的分发. 本仓库以
// GPL-3.0 发布, 两者无法并存. 因此这里只依据酒馆助手公开接口 (`@types/` 里定义, 例如
// `getScriptId` / `eventOn` / `tavern_events`) 重新实现, 构建产物中不再包含模板代码.
// 详见 AGENTS.md 的「许可与依赖边界」.

import { parse as parse_json5 } from 'json5';
import { jsonrepair } from 'jsonrepair';

/** 建一个挂了本脚本 id 的元素: 面板整块挂在酒馆页面上, 带 id 才认得出是谁塞的、才能干净卸掉 */
export function createScriptIdDiv(): JQuery<HTMLDivElement> {
  return $('<div>').attr('script_id', getScriptId()) as JQuery<HTMLDivElement>;
}

/**
 * 把样式从脚本 iframe 搬一份到酒馆页面上, 并挂在本脚本 id 下.
 *
 * 脚本跑在隐藏的 0×0 iframe 里, `import './x.scss'` 注入的样式由 loader 写进 iframe 自己的
 * `<head>`; 而面板 DOM 是挂在酒馆页面上的, 所以样式得搬过去才生效. 外面包一层带 script_id 的
 * div, 是为了关闭面板时能把这一份样式一并清掉.
 */
export function teleportStyle(): { destroy: () => void } {
  const styles = $('head > style', document).clone();
  const $holder = $('<div>').attr('script_id', getScriptId()).append(styles).appendTo('head');
  return {
    destroy: () => $holder.remove(),
  };
}

/** 跟着酒馆切换聊天文件重新加载脚本, 让内部的启动钩子重新跑一遍 */
export function reloadOnChatChange() {
  let chat_id = SillyTavern.getCurrentChatId();
  return eventOn(tavern_events.CHAT_CHANGED, new_chat_id => {
    if (chat_id === new_chat_id) {
      return;
    }
    chat_id = new_chat_id;
    window.location.reload();
  });
}

/** 生成用作本地 id 的随机 UUID v4 */
export function uuidv4(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    // 兜底分支: 只在没有 crypto 的老环境里才会走到
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // 按 RFC 4122 打上版本号 (4) 与变体位
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 序列化成 YAML, 多行文本用 `|` 块, 方便在编辑器里直接读改 */
export function literalYamlify(value: any): string {
  return YAML.stringify(value, { blockQuote: 'literal' });
}

/**
 * 宽泛地解析一段文本: YAML / JSON5 / JSON 依次尝试 (JSON 那一步先过一遍容错修复).
 *
 * 三种都失败才算失败, 并把各自的报错一并抛出, 便于定位用户粘进来的到底是什么.
 * 以 `{` `[` 开头的先按 JSON 走: YAML 虽然是 JSON 的超集, 但它对 JSON5 里合法的尾逗号、
 * 单引号之类并不宽容, 顺序反过来反而更容易解析失败.
 */
export function parseString(content: string): any {
  const like_json = /^[[{]/s.test(content.trimStart());
  const attempts: [string, () => any][] = like_json
    ? [
        ['JSON5', () => parse_json5(content)],
        ['JSON', () => JSON.parse(jsonrepair(content))],
        ['YAML', () => YAML.parse(content, { merge: true })],
      ]
    : [
        ['YAML', () => YAML.parse(content, { merge: true })],
        ['JSON5', () => parse_json5(content)],
        ['JSON', () => JSON.parse(jsonrepair(content))],
      ];

  const failures: string[] = [];
  for (const [format, parse] of attempts) {
    try {
      return parse();
    } catch (error) {
      failures.push(`- ${format}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`内容不是有效的 YAML / JSON / JSON5:\n${failures.join('\n')}`);
}
