// 卡牌系统 - 酒馆助手脚本入口
// - 在酒馆助手脚本按钮区添加「卡牌库」「卡组」「战斗」「调试」四个面板按钮, 以及一次性的「清空角色数据」
// - 卡牌数据以 zod 结构存入 "角色卡变量" 的「卡牌库」命名空间, 并注册给变量管理器校验
// - 卡组数据以 zod 结构存入 "聊天变量" 的「卡组」命名空间 (每个对话独立)
// - 战斗快照 / AI 简报 / 回放写入聊天变量 `战斗.AI`, 出战卡组写入 `战斗.出战卡组`
// - 「调试」面板不绑任何数据: 它量三个作用域的变量占用 + 列出最近的通知, 用于排查异常
// - 世界书条目与正则都由用户手动导入, 脚本不做任何自动注入
import CardLibraryApp from './卡牌/App.vue';
import { hasCharacter } from './卡牌/data';
import { CardLibraryVariableSchema } from './卡牌/schema';
import DeckApp from './卡组/App.vue';
import { hasChat } from './卡组/data';
import { DeckChatVariableSchema } from './卡组/schema';
import BattleApp from './战斗/App.vue';
import { ChatVariableSchema } from './战斗/schema';
import { installBattleBridge } from './战斗/同步';
import DebugApp from './调试/App.vue';
import { clearCardSystemData, confirmClearCardData } from './重置';
import { createScriptIdDiv, reloadOnChatChange, teleportStyle } from '@util/script';

/** 注册变量结构时使用的类型 */
type VariableSchemaType = Parameters<typeof registerVariableSchema>[1]['type'];

interface PanelOptions {
  /** 脚本按钮名, 同时用作提示信息标题 */
  name: string;
  /** 面板内部请求关闭时派发的事件名 */
  close_event: string;
  /** 键盘事件的命名空间, 避免两个面板互相干扰 */
  keydown_namespace: string;
  component: Parameters<typeof createApp>[0];
  /** 打开前的守卫, 不满足时提示并放弃打开 */
  can_open: () => boolean;
  /** 守卫不通过时的提示文案 */
  warning: string;
  /** 注册给变量管理器的结构 (仅影响变量管理器 UI 的校验; 不绑数据的面板可以不填) */
  schema?: Parameters<typeof registerVariableSchema>[0];
  schema_type?: VariableSchemaType;
}

/** 创建一个脚本按钮 + 面板的配对: 负责挂载/卸载 Vue 应用与相关样式 */
function createPanel(options: PanelOptions) {
  let app: ReturnType<typeof createApp> | null = null;
  let $container: JQuery<HTMLDivElement> | null = null;
  let destroy_style: (() => void) | null = null;

  function close() {
    if (!app) {
      return;
    }
    app.unmount();
    app = null;
    $container?.remove();
    $container = null;
    destroy_style?.();
    destroy_style = null;
    $(window).off(`keydown.${options.keydown_namespace}`);
  }

  function open() {
    if (app) {
      return;
    }
    if (!options.can_open()) {
      toastr.warning(options.warning, options.name);
      return;
    }

    $container = createScriptIdDiv().appendTo('body');
    app = createApp(options.component);
    app.mount($container[0]);
    destroy_style = teleportStyle().destroy;

    $(window).on(`keydown.${options.keydown_namespace}`, event => {
      if ((event as JQuery.KeyDownEvent).key === 'Escape') {
        close();
      }
    });
  }

  function toggle() {
    if (app) {
      close();
      return;
    }
    open();
  }

  return { close, open, toggle };
}

const panel_options: PanelOptions[] = [
  {
    name: '卡牌库',
    close_event: 'card-library-close',
    keydown_namespace: 'card-library',
    component: CardLibraryApp,
    can_open: hasCharacter,
    warning: '请先进入一张角色卡后再使用',
    schema: CardLibraryVariableSchema,
    schema_type: 'character',
  },
  {
    name: '卡组',
    close_event: 'card-deck-close',
    keydown_namespace: 'card-deck',
    component: DeckApp,
    can_open: hasChat,
    warning: '请先进入一个对话后再使用',
    schema: DeckChatVariableSchema,
    schema_type: 'chat',
  },
  {
    name: '战斗',
    close_event: 'card-battle-close',
    keydown_namespace: 'card-battle',
    component: BattleApp,
    can_open: hasChat,
    warning: '请先进入一个对话后再使用',
    // 完整结构 (卡组 + 战斗): 注册顺序在 卡组 之后, 后者覆盖前者
    schema: ChatVariableSchema,
    schema_type: 'chat',
  },
  {
    // 全局调试: 不绑任何变量, 欢迎页也能开 (变量读不到时面板会自己说明)
    name: '调试',
    close_event: 'card-debug-close',
    keydown_namespace: 'card-debug',
    component: DebugApp,
    can_open: () => true,
    warning: '',
  },
];

const panels = panel_options.map(createPanel);

/** 一次性动作按钮 (不是面板): 清空当前角色的卡牌与卡组数据 */
const RESET_BUTTON_NAME = '清空角色数据';

/**
 * 「清空角色数据」按钮的处理流程.
 *
 * 顺序很关键: 先确认 (5 秒倒计时) → 再关掉已打开的面板 → 最后才删变量.
 * 面板卸载时会把编辑中的草稿落盘, 如果先删变量, 草稿会把刚删掉的卡又写回来.
 */
async function runClearDataFlow(): Promise<void> {
  // 和其他面板按钮一样先判定数据来源: 欢迎页上既没有角色卡变量也没有聊天变量,
  // 这时弹出来的确认窗没有可清的东西, 还容易被页面盖住点不到, 所以直接提示并放弃.
  if (!hasCharacter() && !hasChat()) {
    toastr.warning('请先进入一张角色卡或一个对话后再使用', RESET_BUTTON_NAME);
    return;
  }
  if (!(await confirmClearCardData())) {
    return;
  }
  panels.forEach(panel => panel.close());
  await clearCardSystemData();
  toastr.success('已清空卡牌库 / 卡组 / 战斗数据', RESET_BUTTON_NAME);
}

$(() => {
  // 变量管理器 UI 校验/展示用 (代码层面无影响)
  for (const options of panel_options) {
    if (!options.schema || !options.schema_type) {
      continue;
    }
    try {
      registerVariableSchema(options.schema, { type: options.schema_type });
    } catch (error) {
      console.warn(`注册${options.name}变量结构失败:`, error);
    }
  }

  // 脚本按钮: 点击开/关面板
  appendInexistentScriptButtons([
    ...panel_options.map(({ name }) => ({ name, visible: true })),
    { name: RESET_BUTTON_NAME, visible: true },
  ]);

  panel_options.forEach((options, index) => {
    eventOn(getButtonEvent(options.name), panels[index].toggle);
    // 面板内部请求关闭
    $(window).on(options.close_event, panels[index].close);
  });

  // 清空按钮: 不走面板, 弹窗确认后直接清变量
  eventOn(getButtonEvent(RESET_BUTTON_NAME), () => {
    void runClearDataFlow();
  });

  // 切换聊天时刷新页面 (角色卡变量 / 聊天变量来源可能变化)
  reloadOnChatChange();

  // 恢复战斗会话 + 安装「AI 回复后自动结算」监听
  void installBattleBridge();

  // 页面卸载时清理挂载的界面
  $(window).on('pagehide', () => panels.forEach(panel => panel.close()));
});
