<!-- 卡牌库管理面板: 左侧列表 / 中间编辑 / 右侧实时预览 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <div class="clp-overlay" :class="{ 'is-narrow': isNarrow }" :style="lookStyle">
    <div class="clp-main">
      <header class="clp-header">
        <div class="clp-titles">
          <span class="clp-title">卡牌库</span>
        </div>
        <span v-if="ready" class="clp-count">共 {{ cards.length }} 张</span>
        <button class="clp-action" type="button" :disabled="!ready" @click="handleExport">导出</button>
        <button class="clp-action" type="button" :disabled="!ready" @click="pickImportFile">导入</button>
        <button class="clp-action" type="button" :disabled="!ready" @click="openAiCard">AI 生成卡牌</button>
        <input
          ref="importInput"
          class="clp-file-input"
          type="file"
          accept=".json,.yaml,.yml,.txt,application/json"
          @change="handleImportFile"
        />
        <button class="clp-action" type="button" :class="{ primary: showLook }" @click="showLook = !showLook">
          外观
        </button>
        <button class="clp-close" type="button" @click="requestClose">✕ 关闭</button>
      </header>

      <!-- 垫底色 / 模糊半径 (三个面板共用同一份设置) -->
      <PanelLookSettings v-if="showLook" @close="showLook = false" />

      <!-- 窄屏 (手机/平板) 时三栏过挤, 拆成 tab 切换 -->
      <nav v-if="isNarrow && ready" class="clp-tabs" aria-label="面板页面切换">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="clp-tab"
          :class="{ active: activeTab === tab.key }"
          @click="switchTab(tab.key)"
        >
          {{ tab.label }}
          <span v-if="tab.key === 'list' && cards.length" class="clp-tab-badge">{{ cards.length }}</span>
        </button>
      </nav>

      <div v-if="errorMessage" class="clp-banner error">
        <span>{{ errorMessage }}</span>
        <button class="btn" type="button" @click="retryLoad">重试</button>
      </div>
      <div v-else-if="ready" class="clp-body">
        <aside class="clp-list" :class="{ 'tab-hidden': !paneVisible('list') }">
          <div class="clp-toolbar">
            <input v-model.trim="keyword" class="search-input" type="search" placeholder="搜索卡名/系列/类型/效果…" />
            <select v-model="rarityFilter" class="rarity-select" aria-label="稀有度筛选">
              <option value="">全部稀有度</option>
              <option v-for="r in RARITIES" :key="r" :value="r">{{ r }}</option>
            </select>
            <select v-model="factionFilter" class="rarity-select" aria-label="阵营筛选">
              <option value="">全部阵营</option>
              <option v-for="faction in CARD_FACTIONS" :key="faction" :value="faction">{{ faction }}</option>
            </select>
            <button
              class="clp-select-toggle"
              :class="{ active: selectMode }"
              type="button"
              @click="toggleSelectMode"
            >
              {{ selectMode ? '完成' : '批量选择' }}
            </button>
          </div>

          <div v-if="selectMode" class="clp-bulk">
            <button class="clp-bulk-btn" type="button" @click="toggleAllChecked">
              {{ allChecked ? '取消全选' : '全选' }}
            </button>
            <span class="clp-bulk-count">已选 {{ checkedIds.length }} 张</span>
            <button
              class="clp-bulk-btn danger"
              type="button"
              :disabled="checkedIds.length === 0"
              @click="deleteChecked"
            >
              删除
            </button>
          </div>

          <div class="clp-items">
            <button
              v-for="card in filteredCards"
              :key="card.id"
              class="clp-item"
              :class="{
                selected: !selectMode && card.id === selectedId,
                checked: selectMode && isChecked(card.id),
                'has-issue': issueList(card.id).length,
              }"
              :title="issueTitle(card.id)"
              type="button"
              @click="onItemClick(card.id)"
            >
              <span class="item-rarity" :class="`rarity-${card.rarity}`">{{ card.rarity }}</span>
              <span class="item-name-row">
                <span v-if="selectMode" class="item-check" :class="{ on: isChecked(card.id) }" aria-hidden="true"></span>
                <span class="item-name">{{ card.name?.trim() || '【未命名卡牌】' }}</span>
                <span v-if="card.阵营 !== '通用'" class="item-faction" :class="`faction-${card.阵营}`">
                  {{ card.阵营 }}
                </span>
                <small v-if="issueList(card.id).length" class="item-issue">数据不完整</small>
              </span>
              <span class="item-type">{{ card.type }}{{ card.series ? `·${card.series}` : '' }}</span>
            </button>
            <div v-if="filteredCards.length === 0" class="clp-empty">
              {{ cards.length === 0 ? '卡牌库为空, 点击下方按钮新建' : '没有符合筛选条件的卡牌' }}
            </div>
          </div>

          <button class="clp-new" type="button" @click="createNew">＋ 新建卡牌</button>
        </aside>

        <section class="clp-editor" :class="{ 'tab-hidden': !paneVisible('edit') }">
          <CardEditor
            ref="editorRef"
            :card="draft"
            :save-state="saveState"
            @patch="applyPatch"
            @delete="deleteSelected"
            @save="commitAndSave"
          />
        </section>

        <section class="clp-preview" :class="{ 'tab-hidden': !paneVisible('preview') }">
          <div class="preview-title">预览</div>
          <CardView :card="draft" />
        </section>
      </div>

      <!-- AI 生成卡牌 -->
      <div v-if="aiOpen" class="clp-modal-mask" @click.self="aiOpen = false">
        <div class="clp-modal">
          <div class="clp-modal-title">AI 生成卡牌</div>
          <p class="clp-modal-hint">
            用一句话描述你想要的卡, AI 会写出一张完整的卡 (含机读效果), 并直接存入卡牌库。
            你的要求优先于一切数值参考, 想要多强、想要什么机制都可以直接写。
            需要一次生成一整套卡? 可以到「卡组」面板用「AI 生成卡组」批量生成。
          </p>
          <label class="clp-modal-field">
            <span>阵营</span>
            <select v-model="aiFaction">
              <option v-for="faction in CARD_FACTIONS" :key="faction" :value="faction">{{ faction }}</option>
            </select>
          </label>
          <label class="clp-modal-field">
            <span>想要什么样的卡</span>
            <textarea
              v-model="aiPrompt"
              rows="4"
              placeholder="例如: 一张 UR 级的炎龙系列从者, 攻击后给目标附加灼烧, 护盾厚一点"
            ></textarea>
          </label>
          <label class="clp-modal-field">
            <span>参考卡 (可选, 用于对齐风格与数值)</span>
            <select v-model="aiRefId">
              <option value="">不参考</option>
              <option v-for="card in cards" :key="card.id" :value="card.id">
                {{ card.name?.trim() || '【未命名卡牌】' }}
              </option>
            </select>
          </label>
          <AiContextField v-model:enabled="aiWithHistory" v-model:count="aiHistory" />
          <div v-if="aiError" class="clp-modal-error">{{ aiError }}</div>
          <AiSettingsLink />
          <div class="clp-modal-actions">
            <button class="clp-action primary" type="button" :disabled="aiBusy" @click="runAiCard">
              {{ aiBusy ? '生成中…' : '生成' }}
            </button>
            <button v-if="aiBusy" class="clp-action" type="button" @click="stopAi">停止</button>
            <button class="clp-action" type="button" :disabled="aiBusy" @click="aiOpen = false">取消</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { aiStopAll } from '../AI/客户端';
import { 生成卡牌 } from '../AI/任务';
import AiContextField from '../AI/components/AiContextField.vue';
import AiSettingsLink from '../AI/components/AiSettingsLink.vue';
import {
  createCard,
  deleteCardById,
  exportLibraryToJson,
  importLibraryFromText,
  loadCards,
  parseLibraryExport,
  saveCard,
} from './data';
import { cardIssueMap } from './校验';
import { CARD_FACTIONS, RARITIES, type Card, type CardFaction, type CardInput } from './schema';
import { confirmDialog } from '../共用/弹窗';
import PanelLookSettings from '../共用/PanelLookSettings.vue';
import {
  flushPanelLookSave,
  loadPanelLook,
  onPanelLookChanged,
  panelLookStyle,
  type PanelLook,
} from '../共用/外观';
import CardEditor from './components/CardEditor.vue';
import CardView from './components/CardView.vue';

const CLOSE_EVENT = 'card-library-close';

const errorMessage = ref('');
const cards = ref<Card[]>([]);
const keyword = ref('');
const rarityFilter = ref('');
const factionFilter = ref<CardFaction | ''>('');
const selectedId = ref<string | null>(null);
const draft = ref<Card | null>(null);
const saveState = ref<{ state: 'idle' | 'saving' | 'saved' | 'error'; error: string }>({ state: 'idle', error: '' });
/** 编辑器组件引用: 切换卡牌/页面/关闭面板前, 先让它提交机读区 (失焦式校验) */
const editorRef = ref<InstanceType<typeof CardEditor> | null>(null);

/** 批量选择模式 (多选删卡) */
const selectMode = ref(false);
const checkedIds = ref<string[]>([]);

// ---- 垫底外观 (与卡组/战斗共享同一份设置) ----
const showLook = ref(false);
const look = ref<PanelLook>(loadPanelLook());
const lookStyle = computed(() => panelLookStyle(look.value));
const off_look = onPanelLookChanged(() => {
  look.value = loadPanelLook();
});

const ready = computed(() => errorMessage.value === '');

// ---- 窄屏适配: 视口过窄时把「搜卡 / 编辑 / 预览」拆成 tab 页 ----
const NARROW_MAX_WIDTH = 1180;
type PaneKey = 'list' | 'edit' | 'preview';
const tabs: { key: PaneKey; label: string }[] = [
  { key: 'list', label: '搜卡' },
  { key: 'edit', label: '编辑' },
  { key: 'preview', label: '预览' },
];
const isNarrow = ref(false);
const activeTab = ref<PaneKey>('list');

/** 某个面板当前是否应显示 (宽屏全部显示, 窄屏只显示激活 tab) */
function paneVisible(pane: PaneKey) {
  return !isNarrow.value || activeTab.value === pane;
}

function switchTab(tab: PaneKey) {
  if (activeTab.value === tab) return;
  commitAndSave();
  activeTab.value = tab;
}

/**
 * 酒馆助手脚本运行在隐藏的 0x0 iframe 中, iframe 自身宽度恒为 0,
 * 用它 matchMedia 会永远命中窄屏. 因此测量视口时必须改用酒馆主窗口
 * (overlay 也挂载在主窗口文档中, 主窗口的宽度才反映真实布局).
 */
const viewportWindow: Window = (() => {
  try {
    const parent = window.parent;
    if (parent && parent !== window && typeof parent.matchMedia === 'function' && parent.document) {
      return parent;
    }
  } catch {
    /* 跨域等异常环境回退到自身 */
  }
  return window;
})();

let narrowMq: MediaQueryList | null = null;
function syncNarrow(query: MediaQueryList | MediaQueryListEvent) {
  isNarrow.value = query.matches;
}
if (typeof viewportWindow.matchMedia === 'function') {
  narrowMq = viewportWindow.matchMedia(`(max-width: ${NARROW_MAX_WIDTH}px)`);
  syncNarrow(narrowMq);
  narrowMq.addEventListener('change', syncNarrow as EventListener);
}

const filteredCards = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return cards.value.filter(card => {
    if (rarityFilter.value && card.rarity !== rarityFilter.value) return false;
    if (factionFilter.value && card.阵营 !== factionFilter.value) return false;
    if (!kw) return true;
    return [card.name, card.series, card.type, card.attribute, card.race, card.description]
      .filter(Boolean)
      .some(text => String(text).toLowerCase().includes(kw));
  });
});

// ---- 批量选择 (多选删卡) ----

/** 当前筛选结果是否已全选 */
const allChecked = computed(
  () => filteredCards.value.length > 0 && filteredCards.value.every(card => checkedIds.value.includes(card.id)),
);

function isChecked(card_id: string): boolean {
  return checkedIds.value.includes(card_id);
}

function onItemClick(card_id: string) {
  if (selectMode.value) {
    toggleChecked(card_id);
    return;
  }
  selectCard(card_id);
}

function toggleChecked(card_id: string) {
  const index = checkedIds.value.indexOf(card_id);
  if (index >= 0) {
    checkedIds.value.splice(index, 1);
  } else {
    checkedIds.value.push(card_id);
  }
}

function toggleSelectMode() {
  selectMode.value = !selectMode.value;
  if (!selectMode.value) {
    checkedIds.value = [];
  }
}

function toggleAllChecked() {
  checkedIds.value = allChecked.value ? [] : filteredCards.value.map(card => card.id);
}

/** 批量删除选中的卡牌 */
async function deleteChecked() {
  const ids = [...checkedIds.value];
  if (ids.length === 0) {
    return;
  }
  const names = ids.map(id => cards.value.find(card => card.id === id)?.name?.trim() || '未命名卡牌');
  const preview = names.slice(0, 8).map(name => `· ${name}`).join('\n');
  const more = names.length > 8 ? `\n· …共 ${names.length} 张` : '';
  const ok = await confirmDialog({
    标题: '删除卡牌',
    内容: `确定删除选中的 ${ids.length} 张卡牌?\n${preview}${more}\n该操作不可撤销。`,
    确认文案: '删除',
    危险: true,
  });
  if (!ok) {
    return;
  }
  // 正在编辑的卡如果也要删掉, 就没必要先把它落盘
  if (!(draft.value && ids.includes(draft.value.id))) {
    commitAndSave();
  }
  try {
    for (const id of ids) {
      deleteCardById(id);
    }
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '删除失败');
    return;
  }
  checkedIds.value = [];
  refreshCards();
  if (selectedId.value && ids.includes(selectedId.value)) {
    selectedId.value = null;
    draft.value = null;
    saveState.value = { state: 'idle', error: '' };
    activeTab.value = 'list';
  }
  toastr.success(`已删除 ${ids.length} 张卡牌`, '卡牌库');
}

function refreshCards() {
  cards.value = loadCards();
}

/** 卡牌库里「数据还没填完 / 数值有问题」的卡牌 (id -> 问题说明) */
const issueMap = computed(() => cardIssueMap(cards.value));

/** 某张卡的数据问题 (空数组表示没问题) */
function issueList(card_id: string): string[] {
  return issueMap.value.get(card_id) ?? [];
}

/** 悬停提示: 列出这张卡具体哪里有问题 */
function issueTitle(card_id: string): string {
  return issueList(card_id).join('；');
}

function retryLoad() {
  errorMessage.value = '';
  try {
    refreshCards();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

/** 请求关闭面板 (由入口脚本监听该 DOM 事件并卸载本组件) */
function requestClose() {
  commitAndSave();
  window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
}

// ---- 导出 / 导入 ----

const importInput = ref<HTMLInputElement | null>(null);

function handleExport() {
  try {
    const json = exportLibraryToJson();
    const doc = viewportWindow.document;
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = doc.createElement('a');
    anchor.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.download = `卡牌库导出-${stamp}.json`;
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toastr.success(`已导出 ${cards.value.length} 张卡牌`, '卡牌库');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '导出失败');
  }
}

function pickImportFile() {
  importInput.value?.click();
}

async function handleImportFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) {
    return;
  }

  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '读取文件失败');
    return;
  }

  let preview: Card[];
  try {
    preview = parseLibraryExport(text);
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '导入失败');
    return;
  }

  if (
    !(await confirmDialog({
      标题: '导入卡牌库',
      内容: `即将导入 ${preview.length} 张卡牌, 同名卡牌会被覆盖, 其余新增。是否继续?`,
      确认文案: '导入',
    }))
  ) {
    return;
  }

  try {
    const result = importLibraryFromText(text);
    refreshCards();
    // 若当前选中卡被覆盖/替换, 同步草稿
    if (selectedId.value) {
      const card = cards.value.find(c => c.id === selectedId.value);
      draft.value = card ? reactive(_.cloneDeep(card)) : null;
      if (!card) {
        selectedId.value = null;
      }
    }
    toastr.success(`导入完成: 新增 ${result.imported} 张, 更新 ${result.updated} 张`, '卡牌库');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '导入失败');
  }
}

// ---- 载入 ----
retryLoad();

function selectCard(card_id: string) {
  if (card_id === selectedId.value) {
    // 窄屏: 再次点击已选中的卡 → 直接进入编辑页
    if (isNarrow.value) switchTab('edit');
    return;
  }
  commitAndSave();
  selectedId.value = card_id;
  const card = cards.value.find(c => c.id === card_id);
  draft.value = card ? reactive(_.cloneDeep(card)) : null;
  saveState.value = { state: 'idle', error: '' };
  if (isNarrow.value) switchTab('edit');
}

function createNew() {
  commitAndSave();
  let card: Card;
  try {
    // 按当前筛选的阵营创建: 筛「敌方」时新建的卡默认也是敌方
    const faction: CardFaction = factionFilter.value === '我方' || factionFilter.value === '敌方' ? factionFilter.value : '通用';
    card = createCard({ 阵营: faction });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    return;
  }
  refreshCards();
  selectedId.value = card.id;
  draft.value = reactive(_.cloneDeep(card));
  saveState.value = { state: 'saved', error: '' };
  if (isNarrow.value) switchTab('edit');
}

async function deleteSelected() {
  if (!draft.value) return;
  const card = draft.value;
  const ok = await confirmDialog({
    标题: '删除卡牌',
    内容: `确定删除卡牌「${card.name?.trim() || '未命名'}」? 该操作不可撤销。`,
    确认文案: '删除',
    危险: true,
  });
  if (!ok) {
    return;
  }
  try {
    deleteCardById(card.id);
  } catch (error) {
    saveState.value = { state: 'error', error: error instanceof Error ? error.message : String(error) };
    return;
  }
  checkedIds.value = checkedIds.value.filter(id => id !== card.id);
  refreshCards();
  draft.value = null;
  selectedId.value = null;
  saveState.value = { state: 'idle', error: '' };
  activeTab.value = 'list';
}

function applyPatch(partial: Partial<Card>) {
  const current = draft.value;
  if (!current) return;
  Object.assign(current, partial);
  // 同步到列表数据: 否则改完阵营后列表标签/筛选仍是旧值, 重新选中这张卡还会把改动顶回去
  const stored = cards.value.find(card => card.id === current.id);
  if (stored) {
    Object.assign(stored, partial);
  }
}

// ---- AI 生成卡牌 ----
const aiOpen = ref(false);
const aiBusy = ref(false);
const aiPrompt = ref('');
const aiFaction = ref<CardFaction>('我方');
const aiRefId = ref('');
const aiWithHistory = ref(false);
const aiHistory = ref(30);
const aiError = ref('');

function openAiCard() {
  aiError.value = '';
  aiFaction.value = factionFilter.value === '我方' || factionFilter.value === '敌方' ? factionFilter.value : '我方';
  aiOpen.value = true;
}

async function runAiCard() {
  if (aiBusy.value) return;
  if (!aiPrompt.value.trim()) {
    aiError.value = '请先描述你想要的卡';
    return;
  }
  aiBusy.value = true;
  aiError.value = '';
  try {
    const ref_card = cards.value.find(card => card.id === aiRefId.value) ?? null;
    const result = await 生成卡牌({
      阵营: aiFaction.value,
      需求: aiPrompt.value,
      参考卡: ref_card,
      带入上下文: aiWithHistory.value,
      历史条数: aiHistory.value,
    });
    const card = createCard({ ...result.card, 阵营: aiFaction.value } as Partial<CardInput>);
    refreshCards();
    selectedId.value = card.id;
    draft.value = reactive(_.cloneDeep(card));
    saveState.value = { state: 'saved', error: '' };
    aiOpen.value = false;
    if (result.warnings.length) {
      toastr.warning(result.warnings.join('\n'), 'AI 生成卡牌');
    } else {
      toastr.success(`已生成「${card.name}」`, 'AI 生成卡牌');
    }
    if (isNarrow.value) switchTab('edit');
  } catch (error) {
    aiError.value = error instanceof Error ? error.message : String(error);
  } finally {
    aiBusy.value = false;
  }
}

function stopAi() {
  aiStopAll();
}

// ---- 自动保存 (300ms 防抖) ----
const scheduleSave = _.debounce(() => {
  if (!draft.value) return;
  saveState.value = { state: 'saving', error: '' };
  try {
    saveCard(draft.value);
    saveState.value = { state: 'saved', error: '' };
  } catch (error) {
    saveState.value = { state: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}, 300);

function flushSave() {
  if (!draft.value) return;
  scheduleSave();
  scheduleSave.flush();
}

/** 先让编辑器提交机读区 (失焦式校验, 语法错误则标红不写入), 再立即把草稿落盘 */
function commitAndSave() {
  editorRef.value?.commitMachine();
  flushSave();
}

watch(draft, () => {
  if (draft.value) {
    scheduleSave();
  }
}, { deep: true });

onBeforeUnmount(() => {
  commitAndSave();
  scheduleSave.cancel();
  window.removeEventListener('beforeunload', commitAndSave);
  narrowMq?.removeEventListener('change', syncNarrow as EventListener);
  off_look();
  flushPanelLookSave();
});

// 切换聊天 (iframe reload) / 页面卸载前, 尽量把草稿落盘
window.addEventListener('beforeunload', commitAndSave);
</script>

<style lang="scss" scoped>
.clp-overlay {
  --cl-bg: #12141c;
  --cl-panel: rgb(var(--panel-tint, 22 24 33) / var(--panel-alpha, 0.92));
  --cl-border: rgb(255 255 255 / 0.1);
  --cl-text: #f0f0f5;
  --cl-text-secondary: #a0a0b0;
  --cl-accent: #89b4fa;
  --cl-hp: #a6e3a1;
  --cl-atk: #f38ba8;
  --cl-shield: #89b4fa;

  /* 面板固定暗色主题, 让原生控件 (下拉菜单/滚动条/复选框) 也用暗色渲染 */
  color-scheme: dark;

  position: fixed;
  inset: 0;
  z-index: 2147483000;
  /* 遮罩只轻压暗一层, 页面仍清晰可见; 虚化交给面板自己的 backdrop-filter */
  background: var(--panel-mask, rgb(8 9 13 / 0.28));
  font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  color: var(--cl-text);
  font-size: 14px;
  display: flex;
  padding: 24px;
  box-sizing: border-box;
  overflow: auto;
}

.clp-main {
  width: 100%;
  max-width: 1560px;
  min-width: 1060px;
  margin: auto;
  position: relative;
  height: min(860px, 100%);
  min-height: 480px;
  background: var(--cl-panel);
  backdrop-filter: blur(var(--panel-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-blur, 10px));
  border: 1px solid var(--cl-border);
  border-radius: 16px;
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.6);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.clp-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--cl-border);
}

.clp-titles {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.clp-title {
  font-size: 1.25em;
  font-weight: 700;
  letter-spacing: 1px;
}

.clp-count {
  font-size: 0.85em;
  color: var(--cl-text-secondary);
}

.clp-close {
  border: 1px solid var(--cl-border);
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  border-radius: 8px;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 0.85em;
}

.clp-close:hover {
  background: rgb(255 255 255 / 0.14);
}

.clp-action {
  border: 1px solid var(--cl-border);
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  border-radius: 8px;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 0.85em;
}

.clp-action:hover {
  background: rgb(255 255 255 / 0.14);
}

.clp-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.clp-action.primary {
  border-color: rgb(137 180 250 / 0.6);
  background: rgb(137 180 250 / 0.18);
  color: var(--cl-accent);
  font-weight: 600;
}

.item-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.item-name-row .item-name {
  flex: 1;
  min-width: 0;
}

.item-faction {
  flex: none;
  font-size: 0.7em;
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid currentcolor;
}

.faction-我方 {
  color: #89b4fa;
}

.faction-敌方 {
  color: #f38ba8;
}

.clp-modal-mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 10;
}

.clp-modal {
  width: min(560px, 100%);
  max-height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  border-radius: 12px;
  border: 1px solid var(--cl-border);
  background: rgb(var(--panel-tint, 22 24 33) / 0.96);
  backdrop-filter: blur(var(--panel-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-blur, 10px));
  box-shadow: 0 18px 50px rgb(0 0 0 / 0.5);
}

.clp-modal-title {
  font-size: 1.05em;
  font-weight: 700;
}

.clp-modal-hint {
  margin: 0;
  font-size: 0.82em;
  color: var(--cl-text-secondary);
}

.clp-modal-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85em;
  color: var(--cl-text-secondary);
}

.clp-modal-field select,
.clp-modal-field textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--cl-border);
  border-radius: 6px;
  background: rgb(0 0 0 / 0.25);
  color: var(--cl-text);
  font-size: 1em;
  padding: 6px 8px;
  font-family: inherit;
  outline: none;
  resize: vertical;
}

.clp-modal-field select option {
  background: #1c1e27;
  color: var(--cl-text);
}

.clp-modal-field select:focus,
.clp-modal-field textarea:focus {
  border-color: var(--cl-accent);
}

.clp-modal-error {
  font-size: 0.82em;
  color: #f38ba8;
  white-space: pre-wrap;
}

.clp-modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.clp-file-input {
  display: none;
}

.clp-banner {
  margin: 14px 18px 0;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 0.88em;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.clp-banner.error {
  background: rgb(243 139 168 / 0.12);
  border: 1px solid rgb(243 139 168 / 0.4);
  color: var(--cl-atk);
}

.clp-banner .btn {
  border: 1px solid rgb(255 255 255 / 0.2);
  background: rgb(255 255 255 / 0.08);
  color: inherit;
  border-radius: 6px;
  padding: 3px 10px;
  cursor: pointer;
  font-size: 0.82em;
}

.clp-body {
  flex: 1;
  display: grid;
  grid-template-columns: 320px minmax(380px, 1fr) 420px;
  gap: 0;
  min-height: 0;
}

/* ---- 左侧列表 ---- */
.clp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-right: 1px solid var(--cl-border);
  min-height: 0;
}

.clp-toolbar {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.search-input,
.rarity-select {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--cl-border);
  border-radius: 6px;
  background: rgb(0 0 0 / 0.25);
  color: var(--cl-text);
  font-size: 0.84em;
  padding: 5px 8px;
  outline: none;
}

.search-input:focus,
.rarity-select:focus {
  border-color: var(--cl-accent);
}

.rarity-select option {
  background: #1c1e27;
  color: var(--cl-text);
}

.clp-select-toggle {
  border: 1px solid var(--cl-border);
  border-radius: 6px;
  background: rgb(255 255 255 / 0.04);
  color: var(--cl-text-secondary);
  font-size: 0.82em;
  padding: 5px 8px;
  cursor: pointer;
  font-family: inherit;
}

.clp-select-toggle:hover {
  background: rgb(255 255 255 / 0.1);
  color: var(--cl-text);
}

.clp-select-toggle.active {
  border-color: rgb(137 180 250 / 0.5);
  background: rgb(137 180 250 / 0.14);
  color: var(--cl-accent);
}

.clp-bulk {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid rgb(137 180 250 / 0.35);
  border-radius: 8px;
  background: rgb(137 180 250 / 0.08);
  font-size: 0.8em;
}

.clp-bulk-count {
  flex: 1;
  color: var(--cl-text-secondary);
}

.clp-bulk-btn {
  border: 1px solid var(--cl-border);
  border-radius: 6px;
  background: rgb(255 255 255 / 0.06);
  color: var(--cl-text);
  font-size: 0.95em;
  padding: 4px 10px;
  cursor: pointer;
  font-family: inherit;
}

.clp-bulk-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.12);
}

.clp-bulk-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.clp-bulk-btn.danger {
  border-color: rgb(243 139 168 / 0.5);
  background: rgb(243 139 168 / 0.16);
  color: #f38ba8;
}

.clp-bulk-btn.danger:hover:not(:disabled) {
  background: rgb(243 139 168 / 0.28);
}

.item-check {
  flex: none;
  width: 13px;
  height: 13px;
  border: 1px solid rgb(255 255 255 / 0.35);
  border-radius: 4px;
  background: rgb(0 0 0 / 0.3);
  position: relative;
}

.item-check.on {
  border-color: var(--cl-accent);
  background: var(--cl-accent);
}

.item-check.on::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 0;
  width: 5px;
  height: 9px;
  border: solid #07111f;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.clp-item.checked {
  background: rgb(137 180 250 / 0.16);
  border-color: rgb(137 180 250 / 0.45);
}

.clp-items {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.clp-item {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 2px 8px;
  align-items: center;
  text-align: left;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font-size: 0.86em;
  cursor: pointer;
  font-family: inherit;
}

.clp-item:hover {
  background: rgb(255 255 255 / 0.06);
}

.clp-item.selected {
  background: rgb(137 180 250 / 0.12);
  border-color: rgb(137 180 250 / 0.5);
}

/* 数据没填完 / 数值读不懂的卡牌: 灰色虚线框, 悬停可看具体原因 */
.clp-item.has-issue {
  border: 1px dashed rgb(255 255 255 / 0.2);
  background: rgb(255 255 255 / 0.02);
  color: rgb(255 255 255 / 0.58);
}

.clp-item.has-issue .item-rarity {
  opacity: 0.6;
}

.item-issue {
  flex: none;
  font-size: 0.7em;
  color: rgb(255 255 255 / 0.4);
  border: 1px dashed rgb(255 255 255 / 0.22);
  border-radius: 4px;
  padding: 0 4px;
  white-space: nowrap;
}

.item-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-type {
  grid-column: 2;
  font-size: 0.74em;
  color: var(--cl-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-rarity {
  grid-row: span 2;
  justify-self: center;
  font-weight: 700;
  font-size: 0.72em;
  padding: 2px 6px;
  border-radius: 5px;
  color: #07111f;
}

.rarity-N {
  background: #b0bec5;
}

.rarity-R {
  background: #81d4fa;
}

.rarity-SR {
  background: linear-gradient(45deg, #ce93d8, #ab47bc);
  color: #fff;
}

.rarity-SSR {
  background: linear-gradient(45deg, #ffd700, #ffb74d);
  color: #442b00;
}

.rarity-UR {
  background: linear-gradient(45deg, #89f7fe, #66a6ff);
  color: #002d62;
}

.clp-empty {
  text-align: center;
  font-size: 0.82em;
  color: var(--cl-text-secondary);
  padding: 18px 4px;
}

.clp-new {
  border: 1px dashed rgb(137 180 250 / 0.5);
  background: rgb(137 180 250 / 0.08);
  color: var(--cl-accent);
  border-radius: 8px;
  padding: 8px;
  cursor: pointer;
  font-size: 0.9em;
}

.clp-new:hover {
  background: rgb(137 180 250 / 0.16);
}

/* ---- 中间编辑 ---- */
.clp-editor {
  padding: 12px 14px;
  overflow-y: auto;
  min-height: 0;
  min-width: 0;
}

/* ---- 右侧预览 ---- */
.clp-preview {
  padding: 12px 14px;
  border-left: 1px solid var(--cl-border);
  overflow-y: auto;
  min-height: 0;
}

.preview-title {
  font-size: 0.8em;
  color: var(--cl-text-secondary);
  margin-bottom: 10px;
  text-align: center;
}

/* ================= 窄屏 (手机/平板) tab 切换模式 ================= */
.clp-tabs {
  flex-shrink: 0;
  display: flex;
  border-bottom: 1px solid var(--cl-border);
  background: rgb(255 255 255 / 0.03);
}

.clp-tab {
  position: relative;
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 6px;
  border: 0;
  background: transparent;
  color: var(--cl-text-secondary);
  font-family: inherit;
  font-size: 0.92em;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.clp-tab.active {
  color: var(--cl-text);
  font-weight: 600;
  background: rgb(137 180 250 / 0.12);
}

.clp-tab.active::after {
  content: '';
  position: absolute;
  inset-inline: 16px;
  bottom: 0;
  height: 2px;
  background: var(--cl-accent);
}

.clp-tab-badge {
  font-size: 0.68em;
  line-height: 1.2;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgb(137 180 250 / 0.22);
  color: var(--cl-accent);
}

.tab-hidden {
  display: none !important;
}

.clp-overlay.is-narrow {
  /* 酒馆窄屏/移动布局会把 body 设为 position:fixed, 使其脱离文档流并令 html 高度塌缩为 0;
     而 html 上存在(恒等)transform(界面缩放机制), 会成为 fixed 子元素的包含块,
     导致上方 .clp-overlay{position:fixed;inset:0} 的尺寸按高度为 0 的 html 计算, 面板不可见。
     此处改为 absolute: body 是定位(fixed)祖先且尺寸恰等于视口, 面板可正确全屏覆盖。 */
  position: absolute;
  top: 0;
  left: 0;
  right: auto;
  bottom: auto;
  width: 100%;
  height: 100%;
  padding: 0;

  .clp-main {
    margin: 0;
    min-width: 0;
    min-height: 0;
    height: 100%;
    max-width: none;
    border-radius: 0;
    border: 0;
    box-shadow: none;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .clp-header {
    padding: 8px 12px;
    gap: 8px;
    flex-wrap: wrap;
  }

  .clp-title {
    font-size: 1.1em;
  }

  .clp-count {
    display: none;
  }

  /* 手机上按钮较多, 缩小一点并允许换行, 避免被裁掉点不到 */
  .clp-action {
    padding: 6px 10px;
  }

  .clp-close {
    padding: 6px 12px;
    font-size: 0.9em;
  }

  .clp-banner {
    margin: 8px 10px 0;
  }

  .clp-body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr);
  }

  .clp-list {
    padding: 8px 10px;
    border-right: 0;
  }

  .clp-editor {
    padding: 10px 12px;
  }

  .clp-preview {
    border-left: 0;
    padding: 10px 12px;
  }
}
</style>
