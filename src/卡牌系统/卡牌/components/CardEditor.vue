<!-- 卡牌编辑器: 元数据 + 自然语言描述 + 机读效果 (YAML) -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <div v-if="card" class="editor">
    <div class="editor-head">
      <span class="editor-title">编辑卡牌</span>
      <span class="save-state" :class="saveState.state" :title="saveState.error">
        {{ saveStateText }}
      </span>
      <span ref="deckAddRef" class="deck-add">
        <button class="btn" type="button" @click="toggleDeckPicker">＋ 加入卡组</button>
        <div v-if="deckPickerOpen" class="deck-picker">
          <button
            v-for="deck in deckOptions"
            :key="deck.id"
            class="deck-option"
            type="button"
            @click="addToDeck(deck.id)"
          >
            <span class="deck-option-name">{{ deck.名称?.trim() || '未命名卡组' }}</span>
            <span class="deck-option-count">{{ deck.卡牌.length }}</span>
          </button>
          <button class="deck-option new" type="button" @click="addToNewDeck">＋ 新建卡组并加入</button>
        </div>
      </span>
      <button class="btn danger" type="button" @click="emit('delete')">删除卡牌</button>
    </div>

    <div class="field-grid">
      <label class="field" :class="{ invalid: fieldIssue('name') }" :title="fieldTitle('name')">
        <span class="field-label">卡名</span>
        <input :value="card.name" type="text" placeholder="愿之芽" @input="onTextInput('name', $event)" />
      </label>
      <label class="field">
        <span class="field-label">系列</span>
        <input :value="card.series" type="text" placeholder="祈愿" @input="onTextInput('series', $event)" />
      </label>
      <label class="field">
        <span class="field-label">阵营</span>
        <select :value="card.阵营" @change="onSelectInput('阵营', $event)">
          <option v-for="faction in CARD_FACTIONS" :key="faction" :value="faction">{{ faction }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">稀有度</span>
        <select :value="card.rarity" @change="onSelectInput('rarity', $event)">
          <option v-for="r in RARITIES" :key="r" :value="r">{{ r }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">星级</span>
        <select :value="card.stars" @change="onStarsSelect($event)">
          <option :value="0">无</option>
          <option v-for="n in MAX_STARS" :key="n" :value="n">{{ '★'.repeat(n) }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">类型</span>
        <input :value="card.type" list="card-type-choices" type="text" @input="onTextInput('type', $event)" />
        <datalist id="card-type-choices">
          <option v-for="choice in CARD_TYPE_CHOICES" :key="choice" :value="choice" />
        </datalist>
      </label>
      <label class="field">
        <span class="field-label">属性</span>
        <input :value="card.attribute" type="text" @input="onTextInput('attribute', $event)" />
      </label>
      <label class="field">
        <span class="field-label">性别</span>
        <input :value="card.gender" type="text" @input="onTextInput('gender', $event)" />
      </label>
      <label class="field">
        <span class="field-label">种族</span>
        <input :value="card.race" type="text" @input="onTextInput('race', $event)" />
      </label>
      <label class="field">
        <span class="field-label">身高</span>
        <input :value="card.height" type="text" @input="onTextInput('height', $event)" />
      </label>
    </div>

    <div class="field-grid stats-grid">
      <label class="field" :class="{ invalid: fieldIssue('energy') }" :title="fieldTitle('energy')">
        <span class="field-label stat-energy-label">能量</span>
        <input :value="card.energy" type="text" placeholder="0" @input="onTextInput('energy', $event)" />
      </label>
      <label class="field" :class="{ invalid: fieldIssue('atk') }" :title="fieldTitle('atk')">
        <span class="field-label stat-atk-label">ATK</span>
        <input :value="card.atk" type="text" placeholder="300" @input="onTextInput('atk', $event)" />
      </label>
      <label class="field" :class="{ invalid: fieldIssue('shield') }" :title="fieldTitle('shield')">
        <span class="field-label stat-shield-label">护盾</span>
        <input :value="card.shield" type="text" placeholder="300" @input="onTextInput('shield', $event)" />
      </label>
      <label class="field" :class="{ invalid: fieldIssue('hp') }" :title="fieldTitle('hp')">
        <span class="field-label stat-hp-label">HP</span>
        <input :value="card.hp" type="text" placeholder="1500" @input="onTextInput('hp', $event)" />
      </label>
    </div>

    <div class="field">
      <span class="field-label">效果描述</span>
      <textarea
        :value="card.description"
        class="description-input"
        rows="5"
        placeholder="当己方墓地存在 2 张以上「炎龙」系列卡牌时, 本卡攻击力提升 20%。"
        @input="onTextInput('description', $event)"
      ></textarea>
    </div>

    <div class="field machine-field">
      <div class="machine-head">
        <span class="field-label machine-label">机读效果 (YAML)</span>
        <span v-if="machineDirty" class="machine-dirty">● 未保存</span>
        <span class="machine-actions">
          <button class="btn subtle" type="button" :disabled="!machineDirty" @click="revertMachine">撤销编辑</button>
          <button class="btn subtle primary" type="button" :disabled="!machineDirty" @click="saveMachine">保存</button>
          <button class="btn subtle" type="button" @click="fillExample">插入示例</button>
        </span>
      </div>
      <textarea
        v-model="machineText"
        class="machine-input"
        :class="{ invalid: !!machineError }"
        rows="10"
        spellcheck="false"
        placeholder="# 单条效果 (省略 on = 常驻修正)&#10;modifiers:&#10;  - stat: atk&#10;    layer: PERCENT_ADD&#10;    value: 0.2"
        @blur="commitMachine"
      ></textarea>
      <span v-if="machineError" class="machine-error">{{ machineError }}</span>
      <span v-else-if="machineIssue" class="machine-note">{{ machineIssue }}</span>
      <!-- AI 写机读: 用户只需用自然语言描述效果 -->
      <div class="machine-ai">
        <button class="btn subtle primary" type="button" :disabled="aiBusy" @click="runAiMachine">
          {{ aiBusy ? '生成中…' : 'AI 写机读' }}
        </button>
        <button class="btn subtle" type="button" @click="aiHintOpen = !aiHintOpen">
          {{ aiHintOpen ? '收起说明' : '补充说明' }}
        </button>
        <button v-if="aiBusy" class="btn subtle" type="button" @click="stopAi">停止</button>
        <span v-if="aiNote" class="machine-ai-note" :class="{ error: aiError }">{{ aiNote }}</span>
      </div>
      <span class="machine-ai-hint">AI 只读取这张卡的卡面信息, 不会带上聊天记录</span>
      <textarea
        v-if="aiHintOpen"
        v-model="aiHint"
        class="machine-input machine-hint-input"
        rows="2"
        placeholder="告诉 AI 你想怎么写机读, 例如: 只做常驻修正 / 不要用召唤效果"
      ></textarea>
      <AiSettingsLink />
    </div>
  </div>

  <div v-else class="editor editor-empty">
    <div class="empty-title">未选择卡牌</div>
    <div class="empty-hint">在「搜卡」列表选择一张卡牌, 或点击「＋ 新建卡牌」</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { aiStopAll } from '../../AI/客户端';
import { 写机读 } from '../../AI/任务';
import AiSettingsLink from '../../AI/components/AiSettingsLink.vue';
import { addCardToDeck, createDeck, hasChat, loadDecks } from '../../卡组/data';
import type { Deck } from '../../卡组/schema';
import { loadCard, machineEffectFromYaml, machineEffectToYaml } from '../data';
import { 机读效果示例 } from '../机读效果示例';
import { cardIssues, type CardIssueField } from '../校验';
import { CARD_FACTIONS, CARD_TYPE_CHOICES, MAX_STARS, RARITIES, type Card } from '../schema';

const props = defineProps<{
  card: Card | null | undefined;
  saveState: { state: 'idle' | 'saving' | 'saved' | 'error'; error: string };
}>();

const emit = defineEmits<{
  patch: [partial: Partial<Card>];
  delete: [];
  /** 请求父级立即把草稿落盘 (机读区手动保存用) */
  save: [];
}>();

// ---- 数据完整性: 没填完/数值读不懂的字段在界面上标灰 ----
const issues = computed(() => (props.card ? cardIssues(props.card) : []));

/** 该输入框对应的数据是否有问题 */
function fieldIssue(field: CardIssueField): boolean {
  return issues.value.some(issue => issue.field === field);
}

/** 悬停提示: 具体哪里有问题 */
function fieldTitle(field: CardIssueField): string {
  return [...new Set(issues.value.filter(issue => issue.field === field).map(issue => issue.message))].join('；');
}

/** 机读区自身的问题 (例如导入来的数据语法不对, 但当前文本还没被编辑过) */
const machineIssue = computed(() => issues.value.find(issue => issue.field === 'machine_effect')?.message ?? '');

// ---- 文本字段改动统一走 patch, 由父级保存 ----
function onTextInput<K extends keyof Card>(key: K, event: Event) {
  emit('patch', { [key]: (event.target as HTMLInputElement | HTMLTextAreaElement).value } as Partial<Card>);
}

function onSelectInput<K extends keyof Card>(key: K, event: Event) {
  emit('patch', { [key]: (event.target as HTMLSelectElement).value } as Partial<Card>);
}

function onStarsSelect(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value);
  emit('patch', { stars: Number.isFinite(value) ? value : 0 });
}

// ---- 机读效果: YAML 文本 <-> 结构化对象 ----
// 设计: 输入过程中不做任何保存 (旧版每敲一个字就解析/保存, 把清空误存为 null),
// 只在失焦 / 切换卡牌或页面 / 手动点「保存」时校验并提交; 语法错误则标红且不写入。
const machineText = ref('');
const machineError = ref('');

/** 编辑框内容与「已保存值」是否不一致 (用于「未保存」提示与按钮禁用) */
const machineDirty = computed(() => machineText.value !== machineEffectToYaml(props.card?.machine_effect));

/** 从当前卡牌对象同步机读文本 (切换卡牌 / 外部改动时) */
function syncMachineFromCard() {
  const yaml = machineEffectToYaml(props.card?.machine_effect);
  if (yaml !== machineText.value) {
    machineText.value = yaml;
  }
  machineError.value = '';
}

// 切换编辑对象时 (卡牌 id 变化) 重新同步
watch(() => props.card?.id, syncMachineFromCard, { immediate: true });

// 外部直接修改 machine_effect 对象时 (deep) 同步文本
watch(() => props.card?.machine_effect, syncMachineFromCard, { deep: true });

/**
 * 校验并提交机读区. 返回是否提交成功 (语法错误时返回 false 并标红, 不写入).
 * 由失焦、切换卡牌/页面、手动「保存」按钮调用.
 */
function commitMachine(): boolean {
  if (!props.card) {
    return false;
  }
  const result = machineEffectFromYaml(machineText.value);
  if (!result.ok) {
    machineError.value = result.error;
    return false;
  }
  machineError.value = '';
  // 统一为规范 YAML, 使「未保存」标记立即归零
  machineText.value = machineEffectToYaml(result.value);
  if (!_.isEqual(props.card.machine_effect ?? undefined, result.value)) {
    emit('patch', { machine_effect: result.value } as Partial<Card>);
  }
  return true;
}

/** 撤销编辑: 丢弃未保存的文本, 从卡牌库 (角色卡变量) 重新读取该卡的机读区 */
function revertMachine() {
  let stored_effect: unknown;
  try {
    stored_effect = props.card ? loadCard(props.card.id)?.machine_effect : undefined;
  } catch {
    // 极端环境下读不到角色卡变量时, 退回当前草稿中的值
    stored_effect = props.card?.machine_effect;
  }
  stored_effect ??= undefined;
  machineError.value = '';
  machineText.value = machineEffectToYaml(stored_effect);
  if (!_.isEqual(props.card?.machine_effect ?? undefined, stored_effect)) {
    emit('patch', { machine_effect: stored_effect } as Partial<Card>);
  }
}

/** 手动保存机读区 (校验通过后请求父级立即落盘) */
function saveMachine() {
  if (commitMachine()) {
    emit('save');
  }
}

function fillExample() {
  machineText.value = 机读效果示例;
  commitMachine();
}

defineExpose({ commitMachine });

// ---- AI 写机读 ----
const aiBusy = ref(false);
const aiHint = ref('');
const aiHintOpen = ref(false);
const aiNote = ref('');
const aiError = ref(false);

async function runAiMachine() {
  const card = props.card;
  if (!card || aiBusy.value) {
    return;
  }
  aiBusy.value = true;
  aiNote.value = '';
  aiError.value = false;
  try {
    const result = await 写机读(card, aiHint.value);
    if (result.error) {
      aiNote.value = result.error;
      aiError.value = true;
      return;
    }
    if (!result.machine_effect) {
      aiNote.value = result.ignored.length
        ? `这张卡的效果无法用机读语法表达: ${result.ignored.join('; ')}`
        : 'AI 认为这张卡没有需要机器识别的效果';
      return;
    }
    machineText.value = machineEffectToYaml(result.machine_effect);
    if (!commitMachine()) {
      aiNote.value = `AI 结果未通过校验: ${machineError.value}`;
      aiError.value = true;
      return;
    }
    emit('save');
    aiNote.value = result.ignored.length ? `已写入; 已忽略: ${result.ignored.join('; ')}` : '✓ 已写入机读效果';
  } catch (error) {
    aiNote.value = error instanceof Error ? error.message : String(error);
    aiError.value = true;
  } finally {
    aiBusy.value = false;
  }
}

function stopAi() {
  aiStopAll();
}

// ---- 快速加入卡组 (卡组数据在当前对话的聊天变量中) ----
const deckAddRef = ref<HTMLElement | null>(null);
const deckPickerOpen = ref(false);
const deckOptions = ref<Deck[]>([]);

function toggleDeckPicker() {
  if (!deckPickerOpen.value) {
    if (!hasChat()) {
      toastr.warning('请先进入一个对话后再使用', '卡组');
      return;
    }
    try {
      deckOptions.value = loadDecks();
    } catch (error) {
      toastr.error(error instanceof Error ? error.message : String(error), '读取卡组失败');
      return;
    }
  }
  deckPickerOpen.value = !deckPickerOpen.value;
}

function addToDeck(deck_id: string) {
  const card = props.card;
  if (!card) return;
  try {
    addCardToDeck(deck_id, card.id);
    const name = deckOptions.value.find(deck => deck.id === deck_id)?.名称?.trim() || '未命名卡组';
    toastr.success(`已加入「${name}」`, '卡组');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '加入失败');
  }
  deckPickerOpen.value = false;
}

function addToNewDeck() {
  const card = props.card;
  if (!card) return;
  try {
    const deck = createDeck();
    addCardToDeck(deck.id, card.id);
    toastr.success('已新建卡组并加入', '卡组');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '新建失败');
  }
  deckPickerOpen.value = false;
}

function onDocumentClick(event: MouseEvent) {
  if (!deckPickerOpen.value) return;
  if (deckAddRef.value && !deckAddRef.value.contains(event.target as Node)) {
    deckPickerOpen.value = false;
  }
}

/**
 * 脚本运行在隐藏 iframe 中, 而面板挂载在酒馆主文档,
 * 因此点击外部要监听主文档而不是 iframe 自己的 document.
 */
const eventDocument: Document = (() => {
  try {
    const parent = window.parent;
    if (parent && parent !== window && parent.document) {
      return parent.document;
    }
  } catch {
    /* 跨域等异常环境回退到自身 */
  }
  return document;
})();

onMounted(() => eventDocument.addEventListener('click', onDocumentClick));
onBeforeUnmount(() => eventDocument.removeEventListener('click', onDocumentClick));

const saveStateText = computed(() => {
  switch (props.saveState.state) {
    case 'saving':
      return '保存中…';
    case 'saved':
      return '✓ 已保存';
    case 'error':
      return '✖ 保存失败';
    default:
      return '—';
  }
});
</script>

<style lang="scss" scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.editor-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.editor-title {
  font-weight: 700;
  font-size: 1.05em;
  flex: 1;
}

.save-state {
  font-size: 0.78em;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.06);
  color: var(--cl-text-secondary, #a0a0b0);
  white-space: nowrap;
}

.save-state.saved {
  color: #a6e3a1;
}

.save-state.error {
  color: #f38ba8;
}

.btn {
  border: 1px solid rgb(255 255 255 / 0.18);
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 0.82em;
  cursor: pointer;
  white-space: nowrap;
}

.btn:hover {
  background: rgb(255 255 255 / 0.12);
}

.btn.danger {
  border-color: rgb(243 139 168 / 0.5);
  color: #f38ba8;
}

.btn.subtle {
  font-size: 0.75em;
  padding: 2px 8px;
}

.btn.primary {
  border-color: rgb(137 180 250 / 0.55);
  background: rgb(137 180 250 / 0.16);
  color: #a9c8ff;
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---- 快速加入卡组 ---- */
.deck-add {
  position: relative;
  flex-shrink: 0;
}

.deck-picker {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  right: 0;
  min-width: 150px;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid rgb(255 255 255 / 0.16);
  border-radius: 8px;
  background: #1c1e27;
  box-shadow: 0 12px 28px rgb(0 0 0 / 0.5);
}

.deck-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 0.82em;
  text-align: left;
  cursor: pointer;
}

.deck-option:hover {
  background: rgb(255 255 255 / 0.1);
}

.deck-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.deck-option-count {
  font-size: 0.85em;
  color: var(--cl-text-secondary, #a0a0b0);
}

.deck-option.new {
  color: #a9c8ff;
  border-top: 1px solid rgb(255 255 255 / 0.1);
  border-radius: 0 0 6px 6px;
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 10px;
}

.stats-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field-label {
  font-size: 0.75em;
  color: var(--cl-text-secondary, #a0a0b0);
}

/* 数据还没填完 / 数值读不懂的字段: 灰色虚线, 悬停看原因 */
.field.invalid .field-label {
  color: rgb(255 255 255 / 0.38);
}

.field.invalid input {
  border-style: dashed;
  border-color: rgb(255 255 255 / 0.3);
  color: rgb(255 255 255 / 0.72);
}

.stat-atk-label {
  color: #f38ba8;
}

.stat-energy-label {
  color: #f9e2af;
}

.stat-shield-label {
  color: #89b4fa;
}

.stat-hp-label {
  color: #a6e3a1;
}

.editor input,
.editor select,
.editor textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid rgb(255 255 255 / 0.15);
  border-radius: 6px;
  background: rgb(0 0 0 / 0.25);
  color: #f0f0f5;
  font-size: 0.86em;
  font-family: inherit;
  padding: 5px 8px;
  outline: none;
}

.editor input:focus,
.editor select:focus,
.editor textarea:focus {
  border-color: #89b4fa;
}

.editor select option {
  background: #1c1e27;
  color: #f0f0f5;
}

.editor textarea {
  resize: vertical;
  line-height: 1.5;
}

.description-input {
  min-height: 90px;
}

.machine-field {
  gap: 6px;
}

.machine-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.machine-label {
  flex: 1;
  min-width: 0;
}

.machine-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.machine-dirty {
  font-size: 0.72em;
  color: #f9e2af;
  white-space: nowrap;
}

.machine-input {
  font-family: 'Cascadia Code', 'Consolas', monospace;
  font-size: 0.8em;
  min-height: 170px;
}

.machine-input.invalid {
  border-color: #f38ba8;
  box-shadow: 0 0 0 1px rgb(243 139 168 / 0.35);
}

.machine-error {
  font-size: 0.78em;
  color: #f38ba8;
}

.machine-note {
  font-size: 0.78em;
  color: rgb(255 255 255 / 0.45);
}

.machine-ai {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.machine-ai-hint {
  font-size: 0.75em;
  color: rgb(255 255 255 / 0.4);
}

.machine-ai-note {
  font-size: 0.78em;
  color: #a6e3a1;
}

.machine-ai-note.error {
  color: #f38ba8;
}

.machine-hint-input {
  min-height: 56px;
}

.editor-empty {
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  min-height: 300px;
  border: 1px dashed rgb(255 255 255 / 0.15);
  border-radius: 10px;
}

.empty-title {
  font-size: 1.1em;
  font-weight: 700;
  color: var(--cl-text-secondary, #a0a0b0);
}

.empty-hint {
  font-size: 0.82em;
  color: var(--cl-text-secondary, #a0a0b0);
  opacity: 0.7;
}

/* 窄屏 (手机/平板) 时 3 列输入框太挤, 依次降到 2 列 / 1 列 */
@media (max-width: 1180px) {
  .field-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 520px) {
  .field-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
