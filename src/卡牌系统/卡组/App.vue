<!-- 卡组管理面板: 左侧卡组列表 / 中间从卡牌库选卡 / 右侧卡组内容与出战 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <div class="dk-overlay" :class="{ 'is-narrow': isNarrow }" :style="lookStyle">
    <div class="dk-main">
      <header class="dk-header">
        <div class="dk-titles">
          <span class="dk-title">卡组</span>
          <span v-if="ready" class="dk-count">{{ decks.length }} 组</span>
          <span v-if="deployedName" class="dk-deployed">出战: {{ deployedName }}</span>
        </div>
        <button class="dk-btn" type="button" :disabled="!ready" @click="openAiDeck">AI 生成卡组</button>
        <button class="dk-btn" type="button" :class="{ primary: showLook }" @click="showLook = !showLook">
          外观
        </button>
        <button class="dk-close" type="button" @click="requestClose">✕ 关闭</button>
      </header>

      <!-- 垫底色 / 模糊半径 (三个面板共用同一份设置) -->
      <PanelLookSettings v-if="showLook" @close="showLook = false" />

      <!-- 窄屏 (手机/平板) 时三栏过挤, 拆成 tab 切换 -->
      <nav v-if="isNarrow && ready" class="dk-tabs" aria-label="面板页面切换">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="dk-tab"
          :class="{ active: activeTab === tab.key }"
          @click="switchTab(tab.key)"
        >
          {{ tab.label }}
          <span v-if="tab.key === 'decks' && decks.length" class="dk-tab-badge">{{ decks.length }}</span>
        </button>
      </nav>

      <div v-if="errorMessage" class="dk-banner error">
        <span>{{ errorMessage }}</span>
        <button class="dk-btn" type="button" @click="retryLoad">重试</button>
      </div>
      <div v-else-if="ready" class="dk-body">
        <!-- 卡组列表 -->
        <aside class="dk-decks" :class="{ 'tab-hidden': !paneVisible('decks') }">
          <div class="dk-faction-tabs">
            <button
              v-for="faction in DECK_FACTIONS"
              :key="faction"
              type="button"
              class="dk-faction-tab"
              :class="{ active: factionFilter === faction }"
              @click="switchFaction(faction)"
            >
              {{ faction }} ({{ factionCount(faction) }})
            </button>
          </div>
          <div class="dk-deck-tools">
            <button class="dk-btn slim" type="button" @click="toggleSelectMode">
              {{ selectMode ? '完成' : '批量选择' }}
            </button>
            <select
              v-if="layerOptions.length > 1"
              v-model="newLayer"
              class="dk-input slim"
              title="新建的卡组放在哪: 放的位置范围越小, 能用到它的地方越少"
              aria-label="新建位置"
            >
              <option v-for="layer in layerOptions" :key="layer" :value="layer">新建到: {{ layer }}</option>
            </select>
          </div>
          <div v-if="selectMode" class="dk-bulk">
            <button class="dk-btn slim" type="button" @click="toggleAllDecks">
              {{ allDecksChecked ? '取消全选' : '全选' }}
            </button>
            <span class="dk-bulk-count">已选 {{ checkedDeckIds.length }} 套</span>
            <button
              class="dk-btn slim"
              type="button"
              :disabled="checkedDeckIds.length === 0 || layerOptions.length < 2"
              title="把选中的卡组搬到别的位置 (聊天 / 角色卡 / 全局)"
              @click="openMigrate"
            >
              迁移…
            </button>
            <button
              class="dk-btn slim danger"
              type="button"
              :disabled="checkedDeckIds.length === 0"
              @click="deleteCheckedDecks"
            >
              删除
            </button>
          </div>
          <div class="dk-deck-items">
            <button
              v-for="deck in visibleDecks"
              :key="deck.id"
              class="dk-deck-item"
              :class="{ selected: deck.id === activeDeckId, checked: selectMode && isDeckChecked(deck.id) }"
              type="button"
              @click="onDeckItemClick(deck.id)"
            >
              <span class="dk-deck-name">
                <span v-if="selectMode" class="dk-check" :class="{ on: isDeckChecked(deck.id) }" aria-hidden="true"></span>
                {{ deck.名称?.trim() || '未命名卡组' }}
              </span>
              <span class="dk-deck-meta">
                {{ deck.卡牌.length }} 张<span v-if="deck.id === deployedDeckId"> · 出战中</span>
                <span v-if="deckLayerName(deck.id)" class="dk-deck-layer">{{ deckLayerName(deck.id) }}</span>
              </span>
              <span v-if="deckWarnCount(deck)" class="dk-deck-warn" :title="deckWarnTitle(deck)">
                不完整
              </span>
            </button>
            <div v-if="visibleDecks.length === 0" class="dk-empty">
              还没有{{ factionFilter }}卡组
            </div>
          </div>
          <button class="dk-new" type="button" @click="createNewDeck">＋ 新建{{ factionFilter }}卡组</button>
        </aside>

        <!-- 从卡牌库选卡 -->
        <section class="dk-pool" :class="{ 'tab-hidden': !paneVisible('pool') }">
          <div class="dk-toolbar">
            <input v-model.trim="keyword" class="dk-input" type="search" placeholder="搜索卡牌…" />
            <select v-model="rarityFilter" class="dk-input" aria-label="稀有度筛选">
              <option value="">全部稀有度</option>
              <option v-for="r in RARITIES" :key="r" :value="r">{{ r }}</option>
            </select>
          </div>

          <div class="dk-pool-items">
            <button
              v-for="card in filteredCards"
              :key="card.id"
              class="dk-pool-item"
              :class="{ 'has-issue': issueList(card.id).length }"
              :title="issueTitle(card.id)"
              :disabled="!activeDeck"
              type="button"
              @click="addCard(card.id)"
            >
              <span class="dk-rarity" :class="`rarity-${card.rarity}`">{{ card.rarity }}</span>
              <span class="dk-pool-name">
                <span class="dk-pool-name-text">{{ card.name?.trim() || '【未命名】' }}</span>
                <small v-if="issueList(card.id).length" class="dk-issue-tag">数据不完整</small>
              </span>
              <span v-if="countInDeck(card.id)" class="dk-pool-count">×{{ countInDeck(card.id) }}</span>
            </button>
            <div v-if="cards.length === 0" class="dk-empty">卡牌库还没有卡牌</div>
            <div v-else-if="poolCards.length === 0" class="dk-empty">这个阵营还没有可用的卡牌</div>
            <div v-else-if="filteredCards.length === 0" class="dk-empty">没有符合筛选条件的卡牌</div>
          </div>

          <div v-if="!activeDeck" class="dk-hint">先选择或新建一个卡组</div>
        </section>

        <!-- 卡组内容 -->
        <section class="dk-detail" :class="{ 'tab-hidden': !paneVisible('detail') }">
          <template v-if="activeDeck">
            <input
              class="dk-input dk-deck-title"
              type="text"
              placeholder="卡组名称"
              :value="activeDeck.名称"
              @input="onNameInput"
            />
            <textarea
              class="dk-input dk-deck-note"
              rows="2"
              placeholder="备注"
              :value="activeDeck.备注"
              @input="onNoteInput"
            ></textarea>

            <div class="dk-faction-row">
              <span>阵营</span>
              <select class="dk-input" :value="activeDeck.阵营" @change="onFactionInput">
                <option v-for="faction in DECK_FACTIONS" :key="faction" :value="faction">{{ faction }}</option>
              </select>
            </div>

            <!-- 卡组级提醒: 比卡牌库里逐张标红弱一些 —— 卡组照常能用, 只是有几张要留意 -->
            <p v-if="activeDeckSummary.total" class="dk-warn-line">
              本卡组{{ activeDeckSummary.text }}; 数据不完整的卡照常上场 (能读的数值照用),
              已不在卡牌库的会被跳过。
            </p>

            <div class="dk-detail-cards">
              <div
                v-for="row in deckRows"
                :key="row.card_id"
                class="dk-row"
                :class="{ 'has-issue': !row.card || issueList(row.card_id).length }"
                :title="row.card ? issueTitle(row.card_id) : '这张卡已不在卡牌库里, 出战时会自动跳过'"
              >
                <span class="dk-rarity" :class="`rarity-${row.card?.rarity ?? 'N'}`">{{ row.card?.rarity ?? '?' }}</span>
                <span class="dk-row-name">
                  <span class="dk-row-name-text">
                    {{ row.card ? row.card.name?.trim() || '【未命名卡牌】' : '卡牌已删除' }}
                  </span>
                  <small v-if="!row.card" class="dk-issue-tag">不在卡牌库</small>
                  <small v-else-if="issueList(row.card_id).length" class="dk-issue-tag">数据不完整</small>
                </span>
                <span class="dk-row-actions">
                  <button class="dk-step" type="button" @click="changeCount(row.card_id, -1)">−</button>
                  <span class="dk-row-count">{{ row.count }}</span>
                  <button class="dk-step" type="button" @click="changeCount(row.card_id, 1)">＋</button>
                </span>
              </div>
              <div v-if="deckRows.length === 0" class="dk-empty">从中间列表点击卡牌加入</div>
            </div>

            <div class="dk-detail-actions">
              <button class="dk-primary" type="button" :disabled="deckRows.length === 0" @click="deploy">
                {{ activeDeck.id === deployedDeckId ? '重新出战' : '出战此卡组' }}
              </button>
              <button v-if="activeDeck.id === deployedDeckId" class="dk-btn" type="button" @click="cancelDeploy">
                取消出战
              </button>
              <button class="dk-btn danger" type="button" @click="removeActiveDeck">删除卡组</button>
              <button class="dk-btn" type="button" @click="copyActiveDeck">
                复制到{{ activeDeck.阵营 === '我方' ? '敌方' : '我方' }}
              </button>
            </div>

            <!-- 默认出战卡组: 只写一个「指针」, 当前对话自己选过的依旧优先 -->
            <div v-if="defaultLayerOptions.length" class="dk-default-row">
              <span class="dk-default-label" :title="defaultTitle">默认出战</span>
              <select v-model="defaultTarget" class="dk-input slim" aria-label="默认出战的位置">
                <option v-for="layer in defaultLayerOptions" :key="layer" :value="layer">{{ layer }}默认</option>
              </select>
              <button class="dk-btn slim" type="button" @click="toggleDefault">
                {{ isDefaultHere ? '取消默认' : '设为默认' }}
              </button>
              <span v-if="deployedFromLayer" class="dk-default-from">
                当前出战卡组来自: {{ deployedFromLayer }}
              </span>
            </div>
          </template>
          <div v-else class="dk-empty">选择或新建一个卡组</div>
        </section>
      </div>

      <!-- AI 生成卡组 -->
      <div v-if="aiOpen" class="dk-modal-mask" @click.self="aiOpen = false">
        <div class="dk-modal">
          <div class="dk-modal-title">AI 生成卡组</div>
          <p class="dk-modal-hint">
            生成的卡牌会以所选阵营存入卡牌库, 并放进卡组; 在卡牌库面板里可以随时查看或修改。
            下面的要求优先于一切数值参考, 不需要考虑和对面对等。
          </p>
          <label class="dk-modal-field">
            <span>生成方式</span>
            <select v-model="aiMode" class="dk-input">
              <option value="new">新建一个卡组</option>
              <option value="append">追加到已有卡组</option>
            </select>
          </label>
          <label class="dk-modal-field">
            <span>卡牌阵营</span>
            <select v-model="aiCardFaction" class="dk-input">
              <option value="跟随">与卡组阵营一致</option>
              <option value="通用">通用 (双方都能使用)</option>
            </select>
          </label>
          <p v-if="aiCardFaction === '通用'" class="dk-modal-note">
            生成的卡牌会标成「通用」, 我方和敌方的卡组都能使用。
          </p>

          <template v-if="aiMode === 'new'">
            <label class="dk-modal-field">
              <span>卡组阵营</span>
              <select v-model="aiNewFaction" class="dk-input" @change="onNewFactionChange">
                <option v-for="faction in DECK_FACTIONS" :key="faction" :value="faction">{{ faction }}</option>
              </select>
            </label>
            <label class="dk-modal-field">
              <span>参考的对手卡组 (可选)</span>
              <select v-model="aiSourceId" class="dk-input">
                <option value="">不参考</option>
                <option v-for="deck in referenceDecks" :key="deck.id" :value="deck.id">
                  {{ deck.名称?.trim() || '未命名卡组' }} ({{ deck.卡牌.length }} 张)
                </option>
              </select>
            </label>
          </template>
          <template v-else>
            <label v-if="decks.length" class="dk-modal-field">
              <span>追加到</span>
              <select v-model="aiTargetId" class="dk-input">
                <option v-for="deck in decks" :key="deck.id" :value="deck.id">
                  {{ deck.名称?.trim() || '未命名卡组' }} ({{ deck.阵营 }} · {{ deck.卡牌.length }} 张)
                </option>
              </select>
            </label>
            <p class="dk-modal-hint">
              这套卡组里已有的卡牌会一起发给 AI, 让它补齐短板, 而不是重复已有卡牌。
            </p>
            <p v-if="!decks.length" class="dk-modal-hint">还没有任何卡组, 请改用「新建一个卡组」。</p>
          </template>

          <label class="dk-modal-field">
            <span>要求 (可选)</span>
            <textarea
              v-model="aiPrompt"
              rows="3"
              placeholder="例如: 想要一套很强的卡 / 多来点陷阱卡 / 围绕当前剧情里的那个敌人做卡"
            ></textarea>
          </label>
          <label class="dk-modal-field">
            <span>{{ aiMode === 'append' ? '新增张数' : '卡牌张数' }}</span>
            <NumberField v-model="aiCount" class="dk-input" :min="1" :max="40" :fallback="20" />
          </label>
          <p v-if="aiCountNum > 10" class="dk-modal-note">
            一次生成 {{ aiCountNum }} 张卡比较多: 建议换用逻辑清晰、分析能力强的模型, 否则可能输出混乱或生成质量下降。
          </p>
          <AiContextField v-model:enabled="aiWithHistory" v-model:count="aiHistory" />
          <div v-if="aiError" class="dk-modal-error">{{ aiError }}</div>
          <AiSettingsLink />
          <AiPromptLink />
          <div class="dk-modal-actions">
            <button class="dk-primary" type="button" :disabled="aiBusy" @click="runAiDeck">
              {{ aiBusy ? '生成中…' : '生成' }}
            </button>
            <button v-if="aiBusy" class="dk-btn" type="button" @click="stopAi">停止</button>
            <button class="dk-btn" type="button" :disabled="aiBusy" @click="aiOpen = false">取消</button>
          </div>
        </div>
      </div>

      <!-- 批量迁移: 选目标位置 + 移动/复制 (两个面板共用同一个弹窗) -->
      <MigrationDialog
        v-if="migrateOpen"
        :标题="`迁移 ${checkedDeckIds.length} 套卡组`"
        :说明="migrateHint"
        :来源="migrateSources"
        :缺卡估算="migrateMissingCount"
        @关闭="migrateOpen = false"
        @确认="applyMigrate"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { aiStopAll } from '../AI/客户端';
import { 生成卡组 } from '../AI/任务';
import AiContextField from '../AI/components/AiContextField.vue';
import AiSettingsLink from '../AI/components/AiSettingsLink.vue';
import AiPromptLink from '../AI/components/AiPromptLink.vue';
import { createCard, loadCards } from '../卡牌/data';
import { cardContentKey, indexCardsByContent } from '../卡牌/去重';
import { cardIssueMap } from '../卡牌/校验';
import { RARITIES, type Card, type CardFaction, type CardInput } from '../卡牌/schema';
import NumberField from '../共用/NumberField.vue';
import PanelLookSettings from '../共用/PanelLookSettings.vue';
import MigrationDialog from '../共用/迁移.vue';
import { confirmDialog, openDialog } from '../共用/弹窗';
import {
  flushPanelLookSave,
  loadPanelLook,
  onPanelLookChanged,
  panelLookStyle,
  type PanelLook,
} from '../共用/外观';
import {
  LAYER_HINTS,
  availableLayers,
  flushLayerSettings,
  onLayerSettingsChanged,
  preferredLayer,
  saveLayerSettings,
  type DataLayer,
} from '../共用/层级';
import {
  addCardToDeck,
  clearDeployedDeck,
  createDeck,
  deckLayer,
  deleteDeck,
  deployDeck,
  describeDeckIssues,
  deckIssues,
  groupDeckCards,
  loadDecks,
  loadDeployedDeck,
  loadDeployedDeckId,
  loadDeployedDeckPointer,
  loadLayerDeployedDeckId,
  migrateDecks,
  missingCardsForDecks,
  resolveDeck,
  saveDeck,
  setCardCount,
  setDefaultDeployedDeck,
  setDeployedDeckId,
  复制卡组,
  type DeckCardRow,
  type DeckIssues,
} from './data';
import { DECK_FACTIONS, type Deck, type DeckFaction, type DeployedDeck } from './schema';

const CLOSE_EVENT = 'card-deck-close';

// ---- 垫底外观 (与卡牌库/战斗共享同一份设置) ----
const showLook = ref(false);
const look = ref<PanelLook>(loadPanelLook());
const lookStyle = computed(() => panelLookStyle(look.value));
const off_look = onPanelLookChanged(() => {
  look.value = loadPanelLook();
});

const errorMessage = ref('');
const decks = ref<Deck[]>([]);
const cards = ref<Card[]>([]);
const deployed = ref<DeployedDeck | undefined>(undefined);
const deployedDeckId = ref('');
const activeDeckId = ref<string | null>(null);
const keyword = ref('');
const rarityFilter = ref('');
const factionFilter = ref<DeckFaction>('我方');

// ---- 数据位置 (聊天 / 角色卡 / 全局) ----

/** 能放卡组的位置 (没有对话时聊天层不可用, 列表会短一些) */
const layerOptions = availableLayers();
/** 新建的卡组放哪一层 (存脚本变量, 换聊天也不会丢) */
const newLayer = ref<DataLayer>(preferredLayer());
const off_layer = onLayerSettingsChanged(() => {
  newLayer.value = preferredLayer();
});
watch(newLayer, value => {
  saveLayerSettings({ 新建位置: value });
});

/** 能当「默认出战」的位置 (当前对话是各聊各的, 不当默认) */
const defaultLayerOptions = computed(() => layerOptions.filter(layer => layer !== '聊天'));
/** 正在设置哪一层的默认出战卡组 */
const defaultTarget = ref<DataLayer>(
  defaultLayerOptions.value[defaultLayerOptions.value.length - 1] ?? '角色卡',
);
const defaultTitle = computed(
  () =>
    `给「${defaultTarget.value}」定一套默认出战卡组: ${LAYER_HINTS[defaultTarget.value]}。\n` +
    '当前对话自己选过的卡组依旧优先。',
);
/** 各层自己存的默认出战卡组 (仅用于界面显示) */
const layerDefaults = ref<Partial<Record<DataLayer, string>>>({});
/** 当前出战卡组的选择是哪儿来的 */
const deployedFrom = ref<DataLayer | ''>('');

/** 这张卡组住在哪一层; 聊天层的不标 */
function deckLayerName(deck_id: string): string {
  const layer = deckLayer(deck_id);
  return layer && layer !== '聊天' ? layer : '';
}

/** 当前选中的卡组是不是「里面那一层」的默认出战卡组 */
const isDefaultHere = computed(() => {
  const deck = activeDeck.value;
  return Boolean(deck) && layerDefaults.value[defaultTarget.value] === deck?.id;
});

/** 当前出战卡组的选择来自哪一层 (聊天 = 这个对话自己选的) */
const deployedFromLayer = computed(() => {
  const layer = deployedFrom.value;
  if (!layer) {
    return '';
  }
  return layer === '聊天' ? '当前对话' : `${layer}默认`;
});

// ---- 卡组多选 (批量迁移 / 批量删除) ----

const selectMode = ref(false);
const checkedDeckIds = ref<string[]>([]);
const allDecksChecked = computed(
  () =>
    visibleDecks.value.length > 0 &&
    visibleDecks.value.every(deck => checkedDeckIds.value.includes(deck.id)),
);

function isDeckChecked(deck_id: string): boolean {
  return checkedDeckIds.value.includes(deck_id);
}

function toggleDeckChecked(deck_id: string) {
  const index = checkedDeckIds.value.indexOf(deck_id);
  if (index >= 0) {
    checkedDeckIds.value.splice(index, 1);
  } else {
    checkedDeckIds.value.push(deck_id);
  }
}

function onDeckItemClick(deck_id: string) {
  if (selectMode.value) {
    toggleDeckChecked(deck_id);
    return;
  }
  selectDeck(deck_id);
}

function toggleSelectMode() {
  selectMode.value = !selectMode.value;
  if (!selectMode.value) {
    checkedDeckIds.value = [];
  }
}

function toggleAllDecks() {
  checkedDeckIds.value = allDecksChecked.value ? [] : visibleDecks.value.map(deck => deck.id);
}

/** 批量删除选中的卡组 */
async function deleteCheckedDecks() {
  const ids = [...checkedDeckIds.value];
  if (ids.length === 0) {
    return;
  }
  const names = ids.map(id => decks.value.find(deck => deck.id === id)?.名称?.trim() || '未命名卡组');
  const preview = names.slice(0, 8).map(name => `· ${name}`).join('\n');
  const more = names.length > 8 ? `\n· …共 ${names.length} 套` : '';
  const ok = await confirmDialog({
    标题: '删除卡组',
    内容: `确定删除选中的 ${ids.length} 套卡组?\n${preview}${more}\n该操作不可撤销。`,
    确认文案: '删除',
    危险: true,
  });
  if (!ok) {
    return;
  }
  scheduleDeckSave.cancel();
  try {
    for (const id of ids) {
      deleteDeck(id);
    }
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '删除失败');
    return;
  }
  checkedDeckIds.value = [];
  activeDeckId.value = null;
  refresh();
  toastr.success(`已删除 ${ids.length} 套卡组`, '卡组');
}

// ---- 批量迁移 ----

const migrateOpen = ref(false);

/** 选中的卡组各自现在在哪一层 */
const migrateSources = computed<DataLayer[]>(() => {
  const layers = checkedDeckIds.value
    .map(id => deckLayer(id))
    .filter((layer): layer is DataLayer => layer !== null);
  return [...new Set(layers)];
});

const migrateHint = computed(() => {
  const parts = migrateSources.value.map(layer => `${layer} 的卡组 (${LAYER_HINTS[layer]})`);
  return parts.length ? `选中的卡组现在是: ${parts.join('、')}。` : '';
});

/** 某个目标位置用不上的卡牌有多少种 (同一张卡只算一次) */
function migrateMissingCount(layer: DataLayer): number {
  return missingCardsForDecks(checkedDeckIds.value, layer).length;
}

function openMigrate() {
  if (checkedDeckIds.value.length === 0) {
    toastr.warning('先勾选要迁移的卡组', '迁移卡组');
    return;
  }
  // 编辑中的草稿先落盘, 否则迁移完可能又被写回旧位置
  flushDeckSave();
  migrateOpen.value = true;
}

function applyMigrate(choice: { 目标: DataLayer; 方式: 'move' | 'copy'; 一并迁移卡牌: boolean }) {
  migrateOpen.value = false;
  const ids = [...checkedDeckIds.value];
  let result: ReturnType<typeof migrateDecks>;
  try {
    result = migrateDecks(ids, choice.目标, choice.方式, { 一并迁移卡牌: choice.一并迁移卡牌 });
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '迁移失败');
    return;
  }
  checkedDeckIds.value = [];
  refresh();
  if (result.写入.length === 0) {
    toastr.info(`选中的卡组本来就在「${choice.目标}」, 没有需要搬的`, '迁移卡组');
    return;
  }
  const 带卡 = result.卡牌 ? `, 并带上了 ${result.卡牌} 张卡牌` : '';
  if (choice.方式 === 'move') {
    toastr.success(`已把 ${result.写入.length} 套卡组移到「${choice.目标}」${带卡}`, '迁移卡组');
  } else {
    toastr.success(
      `已在「${choice.目标}」复制出 ${result.写入.length} 套卡组${带卡} (副本是独立的, 之后改动互不影响)`,
      '迁移卡组',
    );
  }
}

/** 把当前卡组设为（或取消）某一层的默认出战卡组 */
function toggleDefault() {
  const deck = activeDeck.value;
  if (!deck) return;
  const layer = defaultTarget.value;
  try {
    if (layerDefaults.value[layer] === deck.id) {
      setDeployedDeckId('', layer);
      refresh();
      toastr.info(`已取消「${layer}」的默认出战卡组`, '出战卡组');
      return;
    }
    setDefaultDeployedDeck(deck.id, layer);
    const missing = missingCardsForDecks([deck.id], layer).length;
    refresh();
    const note = missing ? `; 这套卡组里有 ${missing} 种卡在「${layer}」看不到, 在别处用可能会缺卡` : '';
    toastr.success(
      `已把「${deck.名称?.trim() || '未命名卡组'}」设为「${layer}」的默认出战卡组${note}`,
      '出战卡组',
    );
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '设置失败');
  }
}

const ready = computed(() => errorMessage.value === '');
const activeDeck = computed(() => decks.value.find(deck => deck.id === activeDeckId.value));
const deckRows = computed<DeckCardRow[]>(() => (activeDeck.value ? groupDeckCards(activeDeck.value) : []));
const deployedName = computed(() => deployed.value?.名称?.trim() || '');

/** 当前阵营下的卡组 (左侧列表) */
const visibleDecks = computed(() => decks.value.filter(deck => deck.阵营 === factionFilter.value));
/** 我方卡组 (生成敌方卡组时作为强度参考的默认候选) */
const playerDecks = computed(() => decks.value.filter(deck => deck.阵营 === '我方'));

/** 卡牌库中「数据还没填完 / 数值有问题」的卡牌 (id -> 问题说明) */
const issueMap = computed(() => cardIssueMap(cards.value));

/** 某张卡的数据问题 (空数组表示没问题) */
function issueList(card_id: string): string[] {
  return issueMap.value.get(card_id) ?? [];
}

/** 悬停提示: 列出这张卡具体哪里有问题 */
function issueTitle(card_id: string): string {
  return issueList(card_id).join('；');
}

/** 一个卡组里的毛病统计 (判定与卡牌库的逐张提醒共用 `deckIssues`) */
function deckIssueCounts(deck: Deck): DeckIssues {
  return deckIssues(deck, cards.value);
}

/** 列表小标记的悬停说明 */
function deckWarnTitle(deck: Deck): string {
  return `${describeDeckIssues(deckIssueCounts(deck))} (仍可出战)`;
}

/** 列表小标记出现的门槛 (有问题就标) */
function deckWarnCount(deck: Deck): number {
  const { 不完整, 缺失 } = deckIssueCounts(deck);
  return 不完整 + 缺失;
}

/** 当前卡组的汇总文案 (没问题的卡组返回空文本与 0) */
const activeDeckSummary = computed(() => {
  const deck = activeDeck.value;
  if (!deck) {
    return { total: 0, text: '' };
  }
  const issues = deckIssueCounts(deck);
  return { total: issues.不完整 + issues.缺失, text: describeDeckIssues(issues) };
});

/** 当前卡组可用的卡牌: 通用卡 + 该阵营专属卡 */
const poolCards = computed(() => {
  const faction = activeDeck.value?.阵营 ?? factionFilter.value;
  return cards.value.filter(card => card.阵营 === '通用' || card.阵营 === faction);
});

function factionCount(faction: DeckFaction): number {
  return decks.value.filter(deck => deck.阵营 === faction).length;
}

const filteredCards = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return poolCards.value.filter(card => {
    if (rarityFilter.value && card.rarity !== rarityFilter.value) return false;
    if (!kw) return true;
    return [card.name, card.series, card.type, card.attribute, card.race, card.description]
      .filter(Boolean)
      .some(text => String(text).toLowerCase().includes(kw));
  });
});

// ---- 窄屏适配: 视口过窄时把「卡组 / 选卡 / 内容」拆成 tab 页 ----
const NARROW_MAX_WIDTH = 1180;
type PaneKey = 'decks' | 'pool' | 'detail';
const tabs: { key: PaneKey; label: string }[] = [
  { key: 'decks', label: '卡组' },
  { key: 'pool', label: '选卡' },
  { key: 'detail', label: '内容' },
];
const isNarrow = ref(false);
const activeTab = ref<PaneKey>('decks');

function paneVisible(pane: PaneKey) {
  return !isNarrow.value || activeTab.value === pane;
}

function switchTab(tab: PaneKey) {
  if (activeTab.value === tab) return;
  flushDeckSave();
  activeTab.value = tab;
}

/**
 * 酒馆助手脚本运行在隐藏的 0x0 iframe 中, 用它 matchMedia 会永远命中窄屏,
 * 因此测量视口必须改用酒馆主窗口.
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

// ---- 载入 ----
function refresh() {
  decks.value = loadDecks();
  cards.value = loadCards();
  deployed.value = loadDeployedDeck();
  deployedDeckId.value = loadDeployedDeckId();
  deployedFrom.value = loadDeployedDeckPointer()?.layer ?? '';
  const defaults: Partial<Record<DataLayer, string>> = {};
  for (const layer of layerOptions) {
    const deck_id = loadLayerDeployedDeckId(layer);
    if (deck_id) {
      defaults[layer] = deck_id;
    }
  }
  layerDefaults.value = defaults;
  if (activeDeckId.value && !decks.value.some(deck => deck.id === activeDeckId.value)) {
    activeDeckId.value = null;
  }
  checkedDeckIds.value = checkedDeckIds.value.filter(id => decks.value.some(deck => deck.id === id));
}

function retryLoad() {
  errorMessage.value = '';
  try {
    refresh();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

try {
  refresh();
} catch (error) {
  errorMessage.value = error instanceof Error ? error.message : String(error);
}

/** 请求关闭面板 (由入口脚本监听该 DOM 事件并卸载本组件) */
function requestClose() {
  flushDeckSave();
  window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
}

// ---- 卡组编辑 ----

/** 名称/备注改动延迟写回, 避免每敲一个字都写变量 */
const scheduleDeckSave = _.debounce((deck: Deck) => {
  try {
    saveDeck(deck);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}, 400);

function flushDeckSave() {
  if (activeDeck.value) {
    scheduleDeckSave(activeDeck.value);
  }
  scheduleDeckSave.flush();
}

function onNameInput(event: Event) {
  if (!activeDeck.value) return;
  activeDeck.value.名称 = (event.target as HTMLInputElement).value;
  scheduleDeckSave(activeDeck.value);
}

function onNoteInput(event: Event) {
  if (!activeDeck.value) return;
  activeDeck.value.备注 = (event.target as HTMLTextAreaElement).value;
  scheduleDeckSave(activeDeck.value);
}

/** 切换卡组阵营 (切换后自动跳到该阵营列表, 避免卡组“消失”) */
function onFactionInput(event: Event) {
  const deck = activeDeck.value;
  if (!deck) return;
  flushDeckSave();
  const faction = (event.target as HTMLSelectElement).value as DeckFaction;
  deck.阵营 = faction;
  try {
    saveDeck(deck);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    return;
  }
  factionFilter.value = faction;
  refresh();
}

/** 切换左侧列表的阵营 */
function switchFaction(faction: DeckFaction) {
  if (factionFilter.value === faction) return;
  flushDeckSave();
  factionFilter.value = faction;
  if (activeDeck.value && activeDeck.value.阵营 !== faction) {
    activeDeckId.value = null;
  }
}

function selectDeck(deck_id: string) {
  if (deck_id === activeDeckId.value) {
    if (isNarrow.value) switchTab('detail');
    return;
  }
  flushDeckSave();
  activeDeckId.value = deck_id;
  if (isNarrow.value) switchTab('detail');
}

function createNewDeck() {
  flushDeckSave();
  try {
    const deck = createDeck(`${factionFilter.value}卡组 ${visibleDecks.value.length + 1}`, factionFilter.value);
    refresh();
    activeDeckId.value = deck.id;
    if (isNarrow.value) switchTab('detail');
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function removeActiveDeck() {
  const deck = activeDeck.value;
  if (!deck) return;
  const ok = await confirmDialog({
    标题: '删除卡组',
    内容: `确定删除卡组「${deck.名称?.trim() || '未命名卡组'}」? 该操作不可撤销。`,
    确认文案: '删除',
    危险: true,
  });
  if (!ok) {
    return;
  }
  scheduleDeckSave.cancel();
  try {
    deleteDeck(deck.id);
    activeDeckId.value = null;
    refresh();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

/** 把当前卡组复制一份到另一个阵营 */
async function copyActiveDeck() {
  const deck = activeDeck.value;
  if (!deck) return;
  flushDeckSave();

  const target: DeckFaction = deck.阵营 === '我方' ? '敌方' : '我方';
  // 通用卡与目标阵营的卡可以直接用, 剩下的就是「只有原阵营能用」的卡
  const one_way: Card[] = [];
  const seen = new Set<string>();
  let missing = 0;
  for (const card_id of deck.卡牌) {
    const card = cards.value.find(item => item.id === card_id);
    if (!card) {
      missing += 1;
      continue;
    }
    if (card.阵营 === '通用' || card.阵营 === target || seen.has(card.id)) continue;
    seen.add(card.id);
    one_way.push(card);
  }

  let one_way_mode: 'ignore' | 'copy' = 'copy';
  if (one_way.length) {
    const preview = one_way
      .slice(0, 6)
      .map(card => `· ${card.name?.trim() || '未命名卡牌'}`)
      .join('\n');
    const more = one_way.length > 6 ? `\n· …共 ${one_way.length} 种` : '';
    const choice = await openDialog({
      标题: `复制到${target}卡组`,
      内容: `这套卡组里有 ${one_way.length} 种卡牌只有「${deck.阵营}」能用:\n${preview}${more}\n\n要忽略这些卡牌, 还是为「${target}」复制一份同内容的卡牌?`,
      按钮: [
        { value: 'cancel', label: '取消' },
        { value: 'ignore', label: '忽略这些卡牌' },
        { value: 'copy', label: `复制一份${target}卡牌`, primary: true },
      ],
    });
    if (choice.button === 'cancel') {
      return;
    }
    one_way_mode = choice.button === 'ignore' ? 'ignore' : 'copy';
  }

  try {
    const result = 复制卡组(deck.id, { 目标阵营: target, 单向卡: one_way_mode });
    refresh();
    factionFilter.value = target;
    activeDeckId.value = result.卡组.id;
    if (isNarrow.value) switchTab('detail');

    const parts = [`已复制为「${result.卡组.名称?.trim() || '未命名卡组'}」共 ${result.卡组.卡牌.length} 张`];
    if (result.复制.length) parts.push(`复制了 ${result.复制.length} 种${target}卡牌`);
    if (result.忽略.length) parts.push(`忽略了 ${result.忽略.length} 种${deck.阵营}专属卡牌`);
    if (result.缺失) parts.push(`${result.缺失} 张卡牌已不在卡牌库中, 已跳过`);
    const message = parts.join(', ');
    if (result.忽略.length || result.缺失) {
      toastr.warning(message, '复制卡组');
    } else {
      toastr.success(message, '复制卡组');
    }
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '复制失败');
  }
}

// ---- 选卡 / 份数 ----

function countInDeck(card_id: string): number {
  return activeDeck.value?.卡牌.filter(id => id === card_id).length ?? 0;
}

function addCard(card_id: string) {
  const deck = activeDeck.value;
  if (!deck) return;
  flushDeckSave();
  try {
    addCardToDeck(deck.id, card_id);
    refresh();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function changeCount(card_id: string, delta: number) {
  const deck = activeDeck.value;
  if (!deck) return;
  flushDeckSave();
  try {
    setCardCount(deck.id, card_id, countInDeck(card_id) + delta);
    refresh();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

// ---- AI 生成卡组 ----

type AiMode = 'new' | 'append';

const aiOpen = ref(false);
const aiBusy = ref(false);
const aiPrompt = ref('');
const aiCount = ref(20);
const aiMode = ref<AiMode>('new');
const aiNewFaction = ref<DeckFaction>('敌方');
/** 生成的卡牌阵营: 跟随卡组阵营, 或统一标成通用 */
const aiCardFaction = ref<'跟随' | '通用'>('跟随');
const aiSourceId = ref('');
const aiTargetId = ref('');
const aiWithHistory = ref(true);
const aiHistory = ref(30);
const aiError = ref('');

/** 张数输入框可能为空, 统一转成数字 */
const aiCountNum = computed(() => Math.trunc(Number(aiCount.value)) || 0);
/** 可参考的对手卡组: 与新建阵营不同的卡组 (生成敌方时参考我方) */
const referenceDecks = computed(() => decks.value.filter(deck => deck.阵营 !== aiNewFaction.value));

function openAiDeck() {
  aiError.value = '';
  aiMode.value = 'new';
  aiNewFaction.value = '敌方';
  aiCardFaction.value = '跟随';
  aiSourceId.value = activeDeck.value?.阵营 === '我方' ? activeDeck.value.id : (playerDecks.value[0]?.id ?? '');
  aiTargetId.value = activeDeck.value?.id ?? (decks.value[0]?.id ?? '');
  aiOpen.value = true;
}

/** 切换新建阵营后, 参考卡组列表也换了, 重置选择避免选中不存在的项 */
function onNewFactionChange() {
  aiSourceId.value = referenceDecks.value[0]?.id ?? '';
}

async function runAiDeck() {
  if (aiBusy.value) return;
  flushDeckSave();

  const count = aiCountNum.value > 0 ? aiCountNum.value : 20;
  const common = {
    需求: aiPrompt.value,
    张数: count,
    带入上下文: aiWithHistory.value,
    历史条数: aiHistory.value,
  };

  let target: Deck | undefined;
  let faction: DeckFaction;
  let reference: Card[] = [];
  if (aiMode.value === 'append') {
    target = decks.value.find(deck => deck.id === aiTargetId.value);
    if (!target) {
      aiError.value = '请先选择要追加的卡组';
      return;
    }
    faction = target.阵营;
  } else {
    faction = aiNewFaction.value;
    const source = decks.value.find(deck => deck.id === aiSourceId.value);
    if (source) {
      reference = resolveDeck(source).卡牌;
    }
  }
  const existing = target ? resolveDeck(target).卡牌 : [];
  const card_faction: CardFaction = aiCardFaction.value === '通用' ? '通用' : faction;

  aiBusy.value = true;
  aiError.value = '';
  try {
    const result = await 生成卡组({
      阵营: faction,
      卡牌阵营: card_faction,
      参考卡组: reference,
      已有卡组: existing,
      ...common,
    });

    // 同一张卡的多份只建一张卡, 卡组里用同一个 id 重复出现表示份数;
    // 内容与卡牌库里已有卡牌完全相同的直接复用, 不再重复入库.
    const reusable = indexCardsByContent(
      loadCards().filter(card => card.阵营 === '通用' || card.阵营 === card_faction),
    );
    const ids: string[] = [];
    let reused = 0;
    for (const draft of result.卡牌) {
      const content = { ...draft, 阵营: card_faction } as Partial<CardInput>;
      const key = cardContentKey(content);
      const known_id = reusable.get(key);
      if (known_id) {
        ids.push(known_id);
        reused += 1;
        continue;
      }
      const card = createCard(content);
      reusable.set(key, card.id);
      ids.push(card.id);
    }
    const reused_note = reused > 0 ? ` (其中 ${reused} 张复用了卡牌库里已有的相同卡牌)` : '';
    const faction_note = card_faction === '通用' ? ', 卡牌阵营: 通用' : '';

    let message: string;
    let created_id: string | null = null;
    if (target) {
      const note = [target.备注?.trim(), result.备注?.trim()].filter(Boolean).join('\n');
      saveDeck({ ...target, 卡牌: [...target.卡牌, ...ids], 备注: note });
      message = `已往「${target.名称?.trim() || '未命名卡组'}」追加 ${ids.length} 张卡牌${faction_note}${reused_note}`;
    } else {
      const deck = createDeck(result.名称 || 'AI 卡组', faction);
      saveDeck({ ...deck, 卡牌: ids, 备注: result.备注 });
      created_id = deck.id;
      message = `已生成「${deck.名称?.trim() || 'AI 卡组'}」共 ${ids.length} 张${faction_note}${reused_note}`;
    }

    factionFilter.value = faction;
    refresh();
    activeDeckId.value = target ? target.id : created_id;
    aiOpen.value = false;
    if (result.warnings.length) {
      toastr.warning(`${message}\n${result.warnings.join('\n')}`, 'AI 生成卡组');
    } else {
      toastr.success(message, 'AI 生成卡组');
    }
    if (isNarrow.value) switchTab('detail');
  } catch (error) {
    aiError.value = error instanceof Error ? error.message : String(error);
  } finally {
    aiBusy.value = false;
  }
}

function stopAi() {
  aiStopAll();
}

// ---- 出战 ----

function deploy() {
  const deck = activeDeck.value;
  if (!deck) return;
  flushDeckSave();
  try {
    const { deployed: snapshot, 缺失 } = deployDeck(deck.id);
    refresh();
    const base = `已出战「${snapshot.名称?.trim() || '未命名卡组'}」共 ${snapshot.卡牌.length} 张`;
    if (缺失.length) {
      toastr.warning(`${base}, 其中 ${缺失.length} 种卡牌已不在卡牌库中`, '卡组');
    } else {
      toastr.success(base, '卡组');
    }
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '出战失败');
  }
}

function cancelDeploy() {
  try {
    clearDeployedDeck();
    refresh();
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '取消失败');
  }
}

onBeforeUnmount(() => {
  flushDeckSave();
  scheduleDeckSave.cancel();
  narrowMq?.removeEventListener('change', syncNarrow as EventListener);
  off_look();
  off_layer();
  flushPanelLookSave();
  flushLayerSettings();
});
</script>

<style lang="scss" scoped>
@use '../共用/稀有度' as *;

.dk-overlay {
  --dk-panel: rgb(var(--panel-tint, 22 24 33) / var(--panel-alpha, 0.92));
  --dk-border: rgb(255 255 255 / 0.1);
  --dk-text: #f0f0f5;
  --dk-text-secondary: #a0a0b0;
  --dk-accent: #89b4fa;

  /* 面板固定暗色主题, 让原生控件 (下拉菜单/滚动条/复选框) 也用暗色渲染 */
  color-scheme: dark;

  position: fixed;
  inset: 0;
  z-index: 2147483000;
  /* 遮罩只轻压暗一层, 页面仍清晰可见; 虚化交给面板自己的 backdrop-filter */
  background: var(--panel-mask, rgb(8 9 13 / 0.28));
  font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  color: var(--dk-text);
  font-size: 14px;
  display: flex;
  padding: 24px;
  box-sizing: border-box;
  overflow: auto;
}

.dk-main {
  width: 100%;
  max-width: 1400px;
  min-width: 960px;
  margin: auto;
  position: relative;
  height: min(820px, 100%);
  min-height: 460px;
  background: var(--dk-panel);
  backdrop-filter: blur(var(--panel-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-blur, 10px));
  border: 1px solid var(--dk-border);
  border-radius: 16px;
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.6);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dk-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--dk-border);
}

.dk-titles {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.dk-title {
  font-size: 1.25em;
  font-weight: 700;
  letter-spacing: 1px;
}

.dk-count,
.dk-deployed {
  font-size: 0.82em;
  color: var(--dk-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dk-deployed {
  color: #a6e3a1;
}

.dk-close {
  border: 1px solid var(--dk-border);
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  border-radius: 8px;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 0.85em;
}

.dk-close:hover {
  background: rgb(255 255 255 / 0.14);
}

.dk-banner {
  margin: 14px 18px 0;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 0.88em;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.dk-banner.error {
  background: rgb(243 139 168 / 0.12);
  border: 1px solid rgb(243 139 168 / 0.4);
  color: #f38ba8;
}

.dk-body {
  flex: 1;
  display: grid;
  grid-template-columns: 240px minmax(300px, 1fr) 380px;
  min-height: 0;
}

/* ---- 左侧卡组列表 ---- */
.dk-decks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-right: 1px solid var(--dk-border);
  min-height: 0;
}

.dk-deck-items {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.dk-faction-tabs {
  display: flex;
  gap: 6px;
}

.dk-faction-tab {
  flex: 1;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--dk-border);
  background: rgb(255 255 255 / 0.04);
  color: var(--dk-text-secondary);
  font-family: inherit;
  font-size: 0.82em;
  cursor: pointer;
}

.dk-faction-tab:hover {
  background: rgb(255 255 255 / 0.1);
}

.dk-faction-tab.active {
  border-color: rgb(137 180 250 / 0.6);
  background: rgb(137 180 250 / 0.16);
  color: var(--dk-accent);
  font-weight: 600;
}

.dk-faction-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85em;
  color: var(--dk-text-secondary);
}

.dk-faction-row select {
  flex: 1;
}

.dk-modal-mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 10;
}

.dk-modal {
  width: min(560px, 100%);
  max-height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  border-radius: 12px;
  border: 1px solid var(--dk-border);
  background: rgb(var(--panel-tint, 22 24 33) / 0.96);
  backdrop-filter: blur(var(--panel-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-blur, 10px));
  box-shadow: 0 18px 50px rgb(0 0 0 / 0.5);
}

.dk-modal-title {
  font-size: 1.05em;
  font-weight: 700;
}

.dk-modal-hint {
  margin: 0;
  font-size: 0.82em;
  line-height: 1.6;
  color: var(--dk-text-secondary);
}

.dk-modal-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85em;
  color: var(--dk-text-secondary);
}

.dk-modal-field textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--dk-border);
  border-radius: 6px;
  background: rgb(0 0 0 / 0.25);
  color: var(--dk-text);
  font-size: 1em;
  padding: 6px 8px;
  font-family: inherit;
  outline: none;
  resize: vertical;
}

.dk-modal-field textarea:focus {
  border-color: var(--dk-accent);
}

.dk-modal-error {
  font-size: 0.82em;
  color: #f38ba8;
  white-space: pre-wrap;
}

/* 张数较多时的灰色小提示 (不是错误, 只是提醒换用更强的模型) */
.dk-modal-note {
  margin: 0;
  font-size: 0.8em;
  line-height: 1.6;
  color: rgb(255 255 255 / 0.45);
}

.dk-modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.dk-deck-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  text-align: left;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 0.88em;
  cursor: pointer;
}

.dk-deck-item:hover {
  background: rgb(255 255 255 / 0.06);
}

.dk-deck-item.selected {
  background: rgb(137 180 250 / 0.12);
  border-color: rgb(137 180 250 / 0.5);
}

.dk-deck-name {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dk-deck-meta {
  font-size: 0.78em;
  color: var(--dk-text-secondary);
}

/* 卡组列表上的「不完整」小标记: 比卡牌库里逐张标红弱一些 */
.dk-deck-warn {
  align-self: flex-start;
  font-size: 0.72em;
  color: rgb(255 255 255 / 0.42);
  border: 1px dashed rgb(255 255 255 / 0.22);
  border-radius: 4px;
  padding: 0 4px;
}

/* 卡组详情里的汇总一行 (照样能出战, 只是提一句) */
.dk-warn-line {
  margin: 0;
  font-size: 0.8em;
  line-height: 1.5;
  color: rgb(255 255 255 / 0.45);
}

/* 左侧列表上方的小工具条: 批量选择 + 新建位置 */
.dk-deck-tools {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 批量选择时才出现的操作条 */
.dk-bulk {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  border: 1px solid rgb(137 180 250 / 0.35);
  border-radius: 8px;
  background: rgb(137 180 250 / 0.08);
}

.dk-bulk-count {
  flex: 1;
  font-size: 0.78em;
  color: var(--dk-text-secondary);
}

.dk-deck-item.checked {
  background: rgb(137 180 250 / 0.16);
  border-color: rgb(137 180 250 / 0.45);
}

/* 多选勾选框 */
.dk-check {
  flex: none;
  width: 12px;
  height: 12px;
  border: 1px solid rgb(255 255 255 / 0.35);
  border-radius: 4px;
  background: rgb(0 0 0 / 0.3);
  position: relative;
}

.dk-check.on {
  border-color: var(--dk-accent);
  background: var(--dk-accent);
}

.dk-check.on::after {
  content: '';
  position: absolute;
  left: 3px;
  top: -1px;
  width: 4px;
  height: 8px;
  border: solid #07111f;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

/* 位置标记: 这套卡组在聊天之外的地方也能用 (角色卡 / 全局) */
.dk-deck-layer {
  margin-left: 4px;
  font-size: 0.92em;
  color: rgb(166 227 161 / 0.75);
  border: 1px solid rgb(166 227 161 / 0.3);
  border-radius: 4px;
  padding: 0 4px;
}

/* 默认出战卡组那一行 */
.dk-default-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 0.82em;
  color: var(--dk-text-secondary);
}

.dk-default-label {
  flex: none;
}

.dk-default-from {
  flex: none;
  color: rgb(166 227 161 / 0.75);
}

.dk-btn.slim {
  padding: 4px 9px;
}

.dk-input.slim {
  width: auto;
  flex: none;
  padding: 4px 6px;
  font-size: 0.82em;
}

.dk-new {
  border: 1px dashed rgb(137 180 250 / 0.5);
  background: rgb(137 180 250 / 0.08);
  color: var(--dk-accent);
  border-radius: 8px;
  padding: 8px;
  cursor: pointer;
  font-size: 0.9em;
  font-family: inherit;
}

.dk-new:hover {
  background: rgb(137 180 250 / 0.16);
}

/* ---- 中间选卡 ---- */
.dk-pool {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  min-height: 0;
}

.dk-toolbar {
  display: flex;
  gap: 6px;
}

.dk-input {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--dk-border);
  border-radius: 6px;
  background: rgb(0 0 0 / 0.25);
  color: var(--dk-text);
  font-size: 0.86em;
  font-family: inherit;
  padding: 5px 8px;
  outline: none;
}

.dk-input:focus {
  border-color: var(--dk-accent);
}

.dk-input option {
  background: #1c1e27;
  color: var(--dk-text);
}

.dk-pool-items {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.dk-pool-item {
  display: grid;
  grid-template-columns: 34px 1fr auto;
  align-items: center;
  gap: 8px;
  text-align: left;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 0.86em;
  cursor: pointer;
}

.dk-pool-item:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.06);
  border-color: rgb(255 255 255 / 0.12);
}

.dk-pool-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dk-pool-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dk-pool-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dk-pool-count {
  font-size: 0.78em;
  color: var(--dk-accent);
}

.dk-hint {
  font-size: 0.78em;
  color: var(--dk-text-secondary);
  text-align: center;
}

/* ---- 右侧卡组内容 ---- */
.dk-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-left: 1px solid var(--dk-border);
  min-height: 0;
}

.dk-deck-title {
  font-size: 1em;
  font-weight: 600;
}

.dk-deck-note {
  resize: vertical;
  line-height: 1.5;
}

.dk-detail-cards {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.dk-row {
  display: grid;
  grid-template-columns: 34px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 8px;
  background: rgb(0 0 0 / 0.22);
  font-size: 0.86em;
}

.dk-row-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dk-row-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 数据没填完 / 数值读不懂的卡牌: 灰色虚线框, 悬停可看具体原因 */
.dk-row.has-issue,
.dk-pool-item.has-issue {
  border: 1px dashed rgb(255 255 255 / 0.2);
  background: rgb(255 255 255 / 0.02);
  color: rgb(255 255 255 / 0.58);
}

.dk-row.has-issue .dk-rarity,
.dk-pool-item.has-issue .dk-rarity {
  opacity: 0.6;
}

.dk-issue-tag {
  flex: none;
  font-size: 0.78em;
  color: rgb(255 255 255 / 0.4);
  border: 1px dashed rgb(255 255 255 / 0.22);
  border-radius: 4px;
  padding: 0 4px;
  white-space: nowrap;
}

.dk-row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.dk-step {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--dk-border);
  border-radius: 5px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}

.dk-step:hover {
  background: rgb(255 255 255 / 0.14);
}

.dk-row-count {
  min-width: 18px;
  text-align: center;
}

.dk-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dk-primary {
  flex: 1;
  min-width: 120px;
  border: 1px solid rgb(137 180 250 / 0.55);
  background: rgb(137 180 250 / 0.16);
  color: #a9c8ff;
  border-radius: 8px;
  padding: 8px;
  font-size: 0.9em;
  font-family: inherit;
  cursor: pointer;
}

.dk-primary:hover:not(:disabled) {
  background: rgb(137 180 250 / 0.26);
}

.dk-primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dk-btn {
  border: 1px solid var(--dk-border);
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 0.82em;
  font-family: inherit;
  cursor: pointer;
}

.dk-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.14);
}

.dk-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dk-btn.danger {
  border-color: rgb(243 139 168 / 0.5);
  color: #f38ba8;
}

/* ---- 稀有度角标 ---- */
.dk-rarity {
  justify-self: center;
  font-weight: 700;
  font-size: 0.72em;
  padding: 2px 6px;
  border-radius: 5px;
  @include rarity-tone;
}

.dk-empty {
  text-align: center;
  font-size: 0.82em;
  color: var(--dk-text-secondary);
  padding: 18px 4px;
}

/* ================= 窄屏 (手机/平板) tab 切换模式 ================= */
.dk-tabs {
  flex-shrink: 0;
  display: flex;
  border-bottom: 1px solid var(--dk-border);
  background: rgb(255 255 255 / 0.03);
}

.dk-tab {
  position: relative;
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 6px;
  border: 0;
  background: transparent;
  color: var(--dk-text-secondary);
  font-family: inherit;
  font-size: 0.92em;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.dk-tab.active {
  color: var(--dk-text);
  font-weight: 600;
  background: rgb(137 180 250 / 0.12);
}

.dk-tab.active::after {
  content: '';
  position: absolute;
  inset-inline: 16px;
  bottom: 0;
  height: 2px;
  background: var(--dk-accent);
}

.dk-tab-badge {
  font-size: 0.68em;
  line-height: 1.2;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgb(137 180 250 / 0.22);
  color: var(--dk-accent);
}

.tab-hidden {
  display: none !important;
}

.dk-overlay.is-narrow {
  /* 酒馆窄屏/移动布局会把 body 设为 position:fixed, 使其脱离文档流并令 html 高度塌缩为 0;
     而 html 上存在(恒等)transform(界面缩放机制), 会成为 fixed 子元素的包含块,
     导致 position:fixed; inset:0 的尺寸按高度为 0 的 html 计算, 面板不可见。
     此处改为 absolute: body 是定位(fixed)祖先且尺寸恰等于视口。 */
  position: absolute;
  top: 0;
  left: 0;
  right: auto;
  bottom: auto;
  width: 100%;
  height: 100%;
  padding: 0;

  .dk-main {
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

  .dk-header {
    padding: 8px 12px;
    gap: 8px;
  }

  .dk-title {
    font-size: 1.1em;
  }

  .dk-count {
    display: none;
  }

  .dk-close {
    padding: 6px 12px;
    font-size: 0.9em;
  }

  .dk-banner {
    margin: 8px 10px 0;
  }

  .dk-body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr);
  }

  .dk-decks,
  .dk-pool,
  .dk-detail {
    padding: 8px 10px;
    border-right: 0;
    border-left: 0;
  }
}
</style>
