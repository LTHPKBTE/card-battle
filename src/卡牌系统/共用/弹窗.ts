// 通用弹窗 (自处理, 不依赖 Vue 组件与面板样式)
//
// 酒馆里的 window.confirm / window.prompt 会弹出浏览器原生对话框: 位置固定在页面顶部、
// 离鼠标很远, 样式也和面板不搭. 这里用一段普通 DOM + 注入样式实现一个面板风格的弹窗,
// 任何地方 (包括非 Vue 模块) 都能直接 await 调用, 不需要在模板里挂组件.
//
// 用法:
//   if (!(await confirmDialog({ 标题: '删除卡牌', 内容: '…', 危险: true }))) return;
//   const text = await promptDialog({ 标题: '卡组名称', 默认值: '我方卡组' });
//   const { button } = await openDialog({ 标题: '复制卡组', 内容: '…', 按钮: [...] });

import { hexToRgbParts, loadPanelLook } from './外观';

/** 弹窗按钮 */
export interface DialogButton {
  /** 点击后返回给调用方的值 */
  value: string;
  /** 按钮文案 */
  label: string;
  /** 主要按钮 (高亮, 回车默认触发) */
  primary?: boolean;
  /** 危险操作 (红色) */
  danger?: boolean;
  /**
   * 延迟多少毫秒后才可点击.
   *
   * 倒计时期间按钮禁用并显示「文案 (Ns)」, 给不可撤销的操作留一个反悔窗口;
   * 回车也会被一并拦下 (否则回车能绕过禁用).
   */
  delay?: number;
}

/** 输入框配置 (提供时弹窗里会多一个输入框) */
export interface DialogInputOptions {
  /** 初始值 */
  value?: string;
  /** 占位文本 */
  placeholder?: string;
  /** 多行输入 (默认单行) */
  multiline?: boolean;
}

export interface DialogOptions {
  标题?: string;
  /** 内容, 支持换行 */
  内容?: string;
  /** 按钮列表 (省略时给「取消 / 确定」) */
  按钮?: DialogButton[];
  /** 需要用户输入时提供 */
  输入?: DialogInputOptions;
  /** 按 Esc / 点遮罩关闭时返回的值, 默认空字符串 */
  取消值?: string;
}

export interface DialogResult {
  /** 被点击按钮的 value (Esc / 点遮罩时是 取消值) */
  button: string;
  /** 输入框内容 (没有输入框时为空字符串) */
  input: string;
}

const STYLE_ID = 'card-system-dialog-style';

const DIALOG_CSS = `
.csdlg-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background: rgb(8 9 13 / 0.4);
  font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  color-scheme: dark;
}
.csdlg-box {
  width: 100%;
  max-width: 440px;
  max-height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 18px;
  border: 1px solid rgb(255 255 255 / 0.12);
  border-radius: 14px;
  background: rgb(var(--csdlg-tint, 22 24 33) / var(--csdlg-alpha, 0.97));
  backdrop-filter: blur(var(--csdlg-blur, 10px));
  -webkit-backdrop-filter: blur(var(--csdlg-blur, 10px));
  box-shadow: 0 20px 60px rgb(0 0 0 / 0.6);
  color: #f0f0f5;
  font-size: 14px;
  line-height: 1.5;
}
.csdlg-title {
  margin-bottom: 10px;
  font-size: 1.05em;
  font-weight: 600;
}
.csdlg-text {
  margin-bottom: 14px;
  color: #c9cad6;
  line-height: 1.6;
  white-space: pre-line;
  word-break: break-word;
}
.csdlg-input {
  box-sizing: border-box;
  width: 100%;
  margin-bottom: 14px;
  padding: 8px 10px;
  border: 1px solid rgb(255 255 255 / 0.16);
  border-radius: 8px;
  background: rgb(0 0 0 / 0.3);
  color: #f0f0f5;
  font: inherit;
  outline: none;
  resize: vertical;
}
.csdlg-input:focus {
  border-color: #89b4fa;
}
.csdlg-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.csdlg-btn {
  padding: 7px 14px;
  border: 1px solid rgb(255 255 255 / 0.16);
  border-radius: 8px;
  background: rgb(255 255 255 / 0.06);
  color: #f0f0f5;
  font: inherit;
  cursor: pointer;
}
.csdlg-btn:hover {
  background: rgb(255 255 255 / 0.12);
}
.csdlg-btn.primary {
  border-color: transparent;
  background: #89b4fa;
  color: #07111f;
  font-weight: 600;
}
.csdlg-btn.primary:hover {
  background: #a3c6fb;
}
.csdlg-btn.danger {
  border-color: transparent;
  background: #f38ba8;
  color: #3a0a16;
  font-weight: 600;
}
.csdlg-btn.danger:hover {
  background: #f7a6bb;
}
/* 延迟亮起的按钮: 必须写在各种 :hover 之后, 否则 hover 会把禁用样式盖掉 */
.csdlg-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.csdlg-btn:disabled:hover {
  background: rgb(255 255 255 / 0.06);
}
.csdlg-btn.primary:disabled:hover {
  background: #89b4fa;
}
.csdlg-btn.danger:disabled:hover {
  background: #f38ba8;
}
`;

/** 关闭当前弹窗 (把它的 Promise 按「取消」结束) */
let activeClose: (() => void) | null = null;

/** 面板渲染在主文档里, 弹窗也必须挂到同一个文档, 否则会被 0x0 的 iframe 裁掉 */
function viewportDocument(): Document {
  try {
    const parent = window.parent;
    if (parent && parent !== window && parent.document) {
      return parent.document;
    }
  } catch {
    /* 跨域等异常环境回退到自身 */
  }
  return document;
}

/** 样式只注入一次 (弹窗在哪个文档, 就注入到哪个文档) */
function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = DIALOG_CSS;
  doc.head.appendChild(style);
}

/** 打开一个弹窗, 返回用户点击的按钮与输入内容 */
export function openDialog(options: DialogOptions = {}): Promise<DialogResult> {
  const doc = viewportDocument();
  ensureStyle(doc);
  // 同一时间只保留一个弹窗: 旧的按「取消」结束
  activeClose?.();

  const buttons: DialogButton[] = options.按钮?.length
    ? options.按钮
    : [
        { value: 'cancel', label: '取消' },
        { value: 'confirm', label: '确定', primary: true },
      ];
  const cancel_value = options.取消值 ?? '';
  const multiline = options.输入?.multiline === true;

  return new Promise<DialogResult>(resolve => {
    const mask = doc.createElement('div');
    mask.className = 'csdlg-mask';

    const box = doc.createElement('div');
    box.className = 'csdlg-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    // 跟面板共用同一套垫底外观 (色 / 透明度 / 模糊半径)
    const look = loadPanelLook();
    box.style.setProperty('--csdlg-tint', hexToRgbParts(look.垫底色));
    box.style.setProperty('--csdlg-alpha', '0.97');
    box.style.setProperty('--csdlg-blur', `${look.模糊半径}px`);

    if (options.标题) {
      const title = doc.createElement('div');
      title.className = 'csdlg-title';
      title.textContent = options.标题;
      box.appendChild(title);
    }
    if (options.内容) {
      const text = doc.createElement('div');
      text.className = 'csdlg-text';
      text.textContent = options.内容;
      box.appendChild(text);
    }

    // 注意: 元素由主文档创建, 不能用 iframe 里的 instanceof 判断类型, 因此这里显式记录
    let input: HTMLInputElement | HTMLTextAreaElement | null = null;
    if (options.输入) {
      input = multiline ? doc.createElement('textarea') : doc.createElement('input');
      input.className = 'csdlg-input';
      if (multiline) {
        (input as HTMLTextAreaElement).rows = 3;
      } else {
        (input as HTMLInputElement).type = 'text';
      }
      input.value = options.输入.value ?? '';
      input.placeholder = options.输入.placeholder ?? '';
      box.appendChild(input);
    }

    const actions = doc.createElement('div');
    actions.className = 'csdlg-actions';
    box.appendChild(actions);

    const countdown_timers: number[] = [];
    let settled = false;
    const finish = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of countdown_timers) {
        window.clearInterval(timer);
      }
      countdown_timers.length = 0;
      doc.removeEventListener('keydown', onKeyDown, true);
      if (activeClose === close) {
        activeClose = null;
      }
      mask.remove();
      resolve({ button: value, input: input?.value ?? '' });
    };
    const close = () => finish(cancel_value);
    activeClose = close;

    const primary = buttons.find(button => button.primary) ?? buttons[buttons.length - 1];
    let primary_element: HTMLButtonElement | null = null;

    /** 先禁用按钮并每秒刷新倒计时, 倒数完了才允许点击 */
    function armDelay(element: HTMLButtonElement, label: string, delay: number): void {
      let left = Math.max(1, Math.ceil(delay / 1000));
      const render = () => {
        element.textContent = left > 0 ? `${label} (${left}s)` : label;
      };
      element.disabled = true;
      render();
      const timer = window.setInterval(() => {
        left -= 1;
        render();
        if (left <= 0) {
          window.clearInterval(timer);
          element.disabled = false;
          element.focus();
        }
      }, 1000);
      countdown_timers.push(timer);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      // 多行输入里回车是换行, 单行输入/普通弹窗回车等于点主要按钮
      if (event.key === 'Enter' && !multiline) {
        event.preventDefault();
        event.stopPropagation();
        // 倒计时期间主要按钮还是禁用的, 这里要一起拦住
        if (!primary_element?.disabled) {
          finish(primary.value);
        }
      }
    }

    for (const button of buttons) {
      const element = doc.createElement('button');
      element.type = 'button';
      element.className = 'csdlg-btn';
      if (button.primary) {
        element.classList.add('primary');
        primary_element = element;
      }
      if (button.danger) {
        element.classList.add('danger');
      }
      element.textContent = button.label;
      if (button.delay && button.delay > 0) {
        armDelay(element, button.label, button.delay);
      }
      element.addEventListener('click', () => finish(button.value));
      actions.appendChild(element);
    }

    mask.addEventListener('click', event => {
      if (event.target === mask) {
        close();
      }
    });
    doc.addEventListener('keydown', onKeyDown, true);

    mask.appendChild(box);
    doc.body.appendChild(mask);

    // 有输入框就先聚焦输入框, 否则聚焦主要按钮
    (input ?? primary_element)?.focus();
  });
}

/** 确认弹窗: 返回是否点了确认按钮 */
export async function confirmDialog(
  options: DialogOptions & { 确认文案?: string; 取消文案?: string; 危险?: boolean },
): Promise<boolean> {
  const result = await openDialog({
    标题: options.标题,
    内容: options.内容,
    取消值: options.取消值,
    按钮: [
      { value: 'cancel', label: options.取消文案 ?? '取消' },
      { value: 'confirm', label: options.确认文案 ?? '确定', primary: !options.危险, danger: options.危险 },
    ],
  });
  return result.button === 'confirm';
}

/** 提示弹窗 (只有确定按钮) */
export async function alertDialog(options: DialogOptions & { 确定文案?: string }): Promise<void> {
  await openDialog({
    标题: options.标题,
    内容: options.内容,
    按钮: [{ value: 'ok', label: options.确定文案 ?? '知道了', primary: true }],
  });
}

/**
 * 危险操作确认弹窗: 确定按钮先禁用一段时间, 倒数完才亮起.
 *
 * 用于「清空数据」这类不可撤销的操作 —— 手快连点两下也删不掉,
 * 必须真的看清楚警告并等完倒计时 (默认 5 秒).
 */
export async function delayedConfirmDialog(
  options: DialogOptions & { 确认文案?: string; 取消文案?: string; 等待毫秒?: number },
): Promise<boolean> {
  const result = await openDialog({
    标题: options.标题,
    内容: options.内容,
    取消值: options.取消值,
    按钮: [
      { value: 'cancel', label: options.取消文案 ?? '取消' },
      { value: 'confirm', label: options.确认文案 ?? '确定', primary: true, danger: true, delay: options.等待毫秒 ?? 5000 },
    ],
  });
  return result.button === 'confirm';
}

/** 输入弹窗: 取消时返回 null */
export async function promptDialog(
  options: DialogOptions & { 默认值?: string; 占位?: string; 多行?: boolean; 确认文案?: string },
): Promise<string | null> {
  const result = await openDialog({
    标题: options.标题,
    内容: options.内容,
    输入: { value: options.默认值 ?? '', placeholder: options.占位 ?? '', multiline: options.多行 },
    按钮: [
      { value: 'cancel', label: '取消' },
      { value: 'confirm', label: options.确认文案 ?? '确定', primary: true },
    ],
  });
  return result.button === 'confirm' ? result.input : null;
}
