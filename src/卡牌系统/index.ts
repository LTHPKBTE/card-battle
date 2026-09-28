// 卡牌系统 - 酒馆助手脚本入口
// - 在酒馆助手脚本按钮区添加「卡牌库」「卡组」「战斗」「数据」「调试」五个面板按钮
// - 卡牌与卡组都可以放在**三个位置** (聊天 / 角色卡 / 全局), 面板读写的是三处合并的结果 ——
//   小范围看得见大范围的东西, 出战卡组按 聊天 > 角色卡 > 全局 回退; 细节见 共用/层级.ts 与 开发说明.md
// - 卡牌数据以 zod 结构存入「卡牌库」命名空间 (默认角色卡变量), 卡组存入「卡组」命名空间 (默认聊天变量)
//   新数据放哪由面板上的「新建到:」选择器决定 (存脚本变量 `数据层级`)
// - 战斗快照 / AI 简报 / 回放写入聊天变量 `战斗.AI`, 出战卡组写入 `战斗.出战卡组` (战斗只属于当前对话)
// - 「数据」面板: 备份 / 恢复 / 分区域清空 (导出与导入在卡牌库与卡组面板里)
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
import DataApp from './数据/App.vue';
import DebugApp from './调试/App.vue';
import { PANEL_CLOSE_EVENTS } from './共用/面板';
import { createScriptIdDiv, reloadOnChatChange, teleportStyle } from './共用/平台';

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
    close_event: PANEL_CLOSE_EVENTS.卡牌库,
    keydown_namespace: 'card-library',
    component: CardLibraryApp,
    can_open: hasCharacter,
    warning: '请先进入一张角色卡后再使用',
    schema: CardLibraryVariableSchema,
    schema_type: 'character',
  },
  {
    name: '卡组',
    close_event: PANEL_CLOSE_EVENTS.卡组,
    keydown_namespace: 'card-deck',
    component: DeckApp,
    // 没进对话时也能管理角色卡 / 全局层的卡组, 所以两处有一个可用就放行
    can_open: () => hasCharacter() || hasChat(),
    warning: '请先进入一张角色卡或一个对话后再使用',
    schema: DeckChatVariableSchema,
    schema_type: 'chat',
  },
  {
    name: '战斗',
    close_event: PANEL_CLOSE_EVENTS.战斗,
    keydown_namespace: 'card-battle',
    component: BattleApp,
    can_open: hasChat,
    warning: '请先进入一个对话后再使用',
    // 完整结构 (卡组 + 战斗): 注册顺序在 卡组 之后, 后者覆盖前者
    schema: ChatVariableSchema,
    schema_type: 'chat',
  },
  {
    // 备份 / 恢复 / 清空: 欢迎页也能开 (变量读不到时面板会自己说明)
    name: '数据',
    close_event: PANEL_CLOSE_EVENTS.数据,
    keydown_namespace: 'card-data',
    component: DataApp,
    can_open: () => true,
    warning: '',
  },
  {
    // 全局调试: 不绑任何变量, 欢迎页也能开 (变量读不到时面板会自己说明)
    name: '调试',
    close_event: PANEL_CLOSE_EVENTS.调试,
    keydown_namespace: 'card-debug',
    component: DebugApp,
    can_open: () => true,
    warning: '',
  },
];

const panels = panel_options.map(createPanel);

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
  appendInexistentScriptButtons(panel_options.map(({ name }) => ({ name, visible: true })));

  panel_options.forEach((options, index) => {
    eventOn(getButtonEvent(options.name), panels[index].toggle);
    // 面板内部请求关闭
    $(window).on(options.close_event, panels[index].close);
  });

  // 切换聊天时刷新页面 (角色卡变量 / 聊天变量来源可能变化)
  reloadOnChatChange();

  // 恢复战斗会话 + 安装「AI 回复后自动结算」监听
  void installBattleBridge();

  // 页面卸载时清理挂载的界面
  $(window).on('pagehide', () => panels.forEach(panel => panel.close()));
});
