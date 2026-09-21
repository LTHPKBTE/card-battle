<!-- 写卡 AI 提示词: 一行灰色小字 + 展开的提示词查看/编辑区 (卡牌库/卡组/卡牌编辑器共用) -->
<!-- 生成卡牌靠的就是这几段文本, 让用户至少能看见它们、并在不满意时自己改。 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <div class="ai-prompt">
    <button class="ai-prompt-hint" type="button" @click="toggle">
      发给 AI 的提示词: {{ customized > 0 ? `已自定义 ${customized} 段` : `${PROMPT_ENTRIES.length} 段` }} · 点击查看 / 修改
    </button>

    <div v-if="open" class="ai-prompt-form">
      <p class="ai-prompt-tip">
        下面是生成卡牌 / 卡组 / 机读时真正发出去的说明文字。改错了可以随时「恢复这一段的默认值」；留空的段落不会发送。
      </p>

      <nav class="ai-prompt-tabs">
        <button
          v-for="item in PROMPT_ENTRIES"
          :key="item.key"
          class="ai-prompt-tab"
          type="button"
          :class="{ active: item.key === activeKey, edited: isCustomized(item.key) }"
          :title="item.标题"
          @click="pick(item.key)"
        >
          {{ item.标题 }}
          <span v-if="item.关键" class="ai-prompt-star" title="关键条目: 改坏了 AI 会产出引擎不认的东西">*</span>
        </button>
      </nav>

      <p class="ai-prompt-desc">
        {{ active.说明 }}
        <span v-if="active.关键" class="ai-prompt-warn">关键条目</span>
      </p>
      <p v-if="activePlaceholders.length" class="ai-prompt-desc">
        可用占位符: <code>{{ activePlaceholders.join(' ') }}</code>
      </p>

      <textarea v-model="draft" class="ai-prompt-text" rows="12" spellcheck="false"></textarea>

      <div class="ai-prompt-actions">
        <button class="ai-prompt-btn primary" type="button" :disabled="!dirty" @click="save">保存这一段</button>
        <button class="ai-prompt-btn" type="button" :disabled="!isCustomized(active.key)" @click="resetActive">
          恢复这一段的默认值
        </button>
        <button class="ai-prompt-btn" type="button" :disabled="customized === 0" @click="resetAll">全部恢复默认</button>
        <span class="ai-prompt-note">{{ note || countLabel }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  PROMPT_ENTRIES,
  PROMPT_TEXT_LIMIT,
  clearPromptOverrides,
  isPromptCustomized,
  loadPromptOverrides,
  onPromptsChanged,
  promptOverrides,
  promptText,
  savePromptOverrides,
  type PromptKey,
} from '../提示词';

const open = ref(false);
const activeKey = ref<PromptKey>(PROMPT_ENTRIES[0].key);
/** 编辑框里的草稿 (改到一半切走不会丢) */
const draft = ref('');
const note = ref('');
/** 每次改动都 +1, 用来驱动「已自定义 / 草稿与保存值是否一致」的重算 */
const revision = ref(0);

const active = computed(() => PROMPT_ENTRIES.find(item => item.key === activeKey.value) ?? PROMPT_ENTRIES[0]);
/** 这一段当前存着的文本 (草稿就是从它复制的) */
const savedText = computed(() => {
  void revision.value;
  return promptText(active.value.key);
});
const dirty = computed(() => draft.value !== savedText.value);
const customized = computed(() => {
  void revision.value;
  const overrides = promptOverrides();
  return PROMPT_ENTRIES.filter(item => typeof overrides[item.key] === 'string').length;
});
const countLabel = computed(() => `共 ${draft.value.length} 字`);
/** 这一段用到的占位符 (卡组任务才有). 拼字符串放在这里, 因为模板里写 {{ 会被当成插值 */
const activePlaceholders = computed(() =>
  [...new Set([...active.value.默认.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => `{{${match[1]}}}`))],
);

function isCustomized(key: PromptKey): boolean {
  void revision.value;
  return isPromptCustomized(key);
}

function pick(key: PromptKey) {
  activeKey.value = key;
  revision.value += 1;
  draft.value = promptText(key);
  note.value = '';
}

function toggle() {
  if (!open.value) {
    loadPromptOverrides();
    revision.value += 1;
    draft.value = promptText(activeKey.value);
    note.value = '';
  }
  open.value = !open.value;
}

function save() {
  const text = draft.value.trim();
  if (!text) {
    note.value = '不能存成空的, 想删掉请用「恢复这一段的默认值」';
    return;
  }
  if (text.length > PROMPT_TEXT_LIMIT) {
    note.value = `太长了 (上限 ${PROMPT_TEXT_LIMIT} 字)`;
    return;
  }
  const next = { ...promptOverrides() };
  next[activeKey.value] = text;
  savePromptOverrides(next);
  revision.value += 1;
  draft.value = savedText.value;
  note.value = '已保存';
}

function resetActive() {
  const next = { ...promptOverrides() };
  delete next[activeKey.value];
  savePromptOverrides(next);
  revision.value += 1;
  draft.value = savedText.value;
  note.value = '已恢复默认';
}

function resetAll() {
  clearPromptOverrides();
  revision.value += 1;
  draft.value = savedText.value;
  note.value = '全部恢复默认';
}

onMounted(() => {
  loadPromptOverrides();
  revision.value += 1;
  draft.value = promptText(activeKey.value);
});

/** 别的面板改了提示词时同步 (同一个模块实例, 直接订阅即可) */
const off_changed = onPromptsChanged(() => {
  revision.value += 1;
  if (!open.value) {
    draft.value = promptText(activeKey.value);
  }
});

onBeforeUnmount(off_changed);
</script>

<style lang="scss" scoped>
.ai-prompt {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai-prompt-hint {
  align-self: flex-start;
  border: none;
  background: none;
  padding: 0;
  font-family: inherit;
  font-size: 0.78em;
  line-height: 1.6;
  color: rgb(255 255 255 / 0.42);
  cursor: pointer;
  text-align: left;
}

.ai-prompt-hint:hover {
  color: rgb(255 255 255 / 0.75);
  text-decoration: underline;
}

.ai-prompt-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgb(255 255 255 / 0.14);
  border-radius: 8px;
  background: rgb(0 0 0 / 0.22);
}

.ai-prompt-tip {
  margin: 0;
  font-size: 0.76em;
  line-height: 1.6;
  color: rgb(255 255 255 / 0.5);
}

.ai-prompt-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.ai-prompt-tab {
  border: 1px solid rgb(255 255 255 / 0.16);
  background: rgb(255 255 255 / 0.05);
  color: inherit;
  border-radius: 6px;
  padding: 3px 8px;
  font-family: inherit;
  font-size: 0.78em;
  cursor: pointer;
}

.ai-prompt-tab:hover {
  background: rgb(255 255 255 / 0.12);
}

.ai-prompt-tab.active {
  border-color: rgb(137 180 250 / 0.55);
  background: rgb(137 180 250 / 0.16);
  color: #89b4fa;
}

/* 改过的那一段点一下星号标记, 免得忘了自己动过哪里 */
.ai-prompt-tab.edited .ai-prompt-star,
.ai-prompt-star {
  color: #f9e2af;
}

.ai-prompt-tab:not(.edited) .ai-prompt-star {
  color: rgb(255 255 255 / 0.3);
}

.ai-prompt-desc {
  margin: 0;
  font-size: 0.76em;
  line-height: 1.6;
  color: rgb(255 255 255 / 0.5);
}

.ai-prompt-desc code {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 4px;
  background: rgb(0 0 0 / 0.35);
}

.ai-prompt-warn {
  margin-left: 6px;
  color: #f9e2af;
}

.ai-prompt-text {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  border: 1px solid rgb(255 255 255 / 0.18);
  border-radius: 6px;
  background: rgb(0 0 0 / 0.3);
  color: inherit;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.78em;
  line-height: 1.6;
  padding: 6px 8px;
  outline: none;
  resize: vertical;
}

.ai-prompt-text:focus {
  border-color: #89b4fa;
}

.ai-prompt-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ai-prompt-btn {
  border: 1px solid rgb(255 255 255 / 0.2);
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  border-radius: 6px;
  padding: 4px 10px;
  font-family: inherit;
  font-size: 0.82em;
  cursor: pointer;
}

.ai-prompt-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.14);
}

.ai-prompt-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.ai-prompt-btn.primary {
  border-color: rgb(137 180 250 / 0.55);
  background: rgb(137 180 250 / 0.16);
  color: #89b4fa;
}

.ai-prompt-note {
  font-size: 0.78em;
  color: rgb(255 255 255 / 0.5);
}
</style>
