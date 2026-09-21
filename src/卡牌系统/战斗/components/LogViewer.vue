<!-- 战斗日志弹窗: 操作记录 / 引擎日志 / AI 决策 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <BattleModal title="战斗日志" :subtitle="`${filtered.length} / ${items.length} 条`" wide @close="emit('close')">
    <div class="lv-bar">
      <input v-model="search" class="lv-search" type="search" placeholder="搜索正文 / 类别…" />
      <div class="lv-mode">
        <button
          class="lv-mode-btn"
          :class="{ on: mode === 'OR' }"
          type="button"
          title="满足任意一个选中的标签"
          @click="mode = 'OR'"
        >
          任一
        </button>
        <button
          class="lv-mode-btn"
          :class="{ on: mode === 'AND' }"
          type="button"
          title="必须同时满足所有选中的标签"
          @click="mode = 'AND'"
        >
          同时
        </button>
      </div>
      <button class="lv-reset" type="button" title="回到默认筛选 (信息及以上)" @click="reset">默认</button>
    </div>

    <div v-for="group in LOG_FILTER_GROUPS" :key="group.title" class="lv-group">
      <span class="lv-group-title">{{ group.title }}</span>
      <button
        v-for="option in group.options"
        :key="option.key"
        class="lv-chip"
        :class="{ on: selected.includes(option.key) }"
        type="button"
        @click="toggle(option.key)"
      >
        {{ option.label }}<em v-if="counts[option.key]">{{ counts[option.key] }}</em>
      </button>
      <span v-if="group.hint" class="lv-hint">{{ group.hint }}</span>
    </div>

    <p class="lv-tips">
      标签之间按「{{ mode === 'OR' ? '任一' : '同时' }}」匹配，搜索词始终需要匹配；标签一个都不选 = 不按标签筛。
    </p>

    <div ref="listRef" class="lv-list">
      <p v-if="filtered.length === 0" class="lv-empty">没有符合条件的记录。试试放宆筛选或点「默认」。</p>
      <div
        v-for="item in filtered"
        :key="item.id"
        class="lv-item"
        :class="[
          `lv-src-${item.source}`,
          item.kind ? `lv-kind-${item.kind}` : '',
          item.level ? `lv-lv-${item.level}` : '',
        ]"
      >
        <span class="lv-turn">T{{ item.turn }}</span>
        <span class="lv-label">{{ item.label }}</span>
        <span v-if="item.level === 'WARN' || item.level === 'ERROR'" class="lv-level">
          {{ LOG_LEVEL_LABELS[item.level] }}
        </span>
        <span v-if="item.internal" class="lv-internal" title="引擎内部问题，不会发进 AI 简报">内部</span>
        <span class="lv-text">{{ item.text }}</span>
      </div>
    </div>
  </BattleModal>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import {
  DEFAULT_LOG_FILTER_KEYS,
  DEFAULT_LOG_QUERY,
  LOG_FILTER_GROUPS,
  LOG_LEVEL_LABELS,
  filterLogs,
  logCounts,
  type BattleLogItem,
  type LogFilterKey,
  type LogMatchMode,
  type LogQuery,
} from '../日志.ts';
import BattleModal from './BattleModal.vue';

const props = defineProps<{ items: BattleLogItem[] }>();
const emit = defineEmits<{ close: [] }>();

/** 选中的过滤项 (默认 = 信息及以上, 看不到调试) */
const selected = ref<LogFilterKey[]>([...DEFAULT_LOG_FILTER_KEYS]);
const mode = ref<LogMatchMode>(DEFAULT_LOG_QUERY.mode);
const search = ref(DEFAULT_LOG_QUERY.search);
const listRef = ref<HTMLElement | null>(null);

const counts = computed(() => logCounts(props.items));
const query = computed<LogQuery>(() => ({ keys: selected.value, mode: mode.value, search: search.value }));
const filtered = computed(() => filterLogs(props.items, query.value));

/** 点一下切换选中 (多选, 不互斥) */
function toggle(key: LogFilterKey) {
  selected.value = selected.value.includes(key)
    ? selected.value.filter(item => item !== key)
    : [...selected.value, key];
}

/** 回到默认筛选 */
function reset() {
  selected.value = [...DEFAULT_LOG_FILTER_KEYS];
  mode.value = DEFAULT_LOG_QUERY.mode;
  search.value = DEFAULT_LOG_QUERY.search;
}

/** 新日志总是最新的 → 打开时和追加时都滚到底部 */
function scrollToBottom() {
  const list = listRef.value;
  if (list) {
    list.scrollTop = list.scrollHeight;
  }
}

onMounted(() => void nextTick(scrollToBottom));
watch(() => filtered.value.length, () => void nextTick(scrollToBottom));
</script>

<style scoped>
.lv-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.lv-search {
  flex: 1;
  min-width: 0;
  padding: 4px 10px;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.12));
  border-radius: 8px;
  background: rgb(0 0 0 / 0.22);
  color: inherit;
  font-family: inherit;
  font-size: 0.84em;
}

.lv-search::placeholder {
  color: var(--bt-text-secondary, #a0a0b0);
}

.lv-mode {
  display: flex;
  flex: none;
  overflow: hidden;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.12));
  border-radius: 8px;
}

.lv-mode-btn,
.lv-reset {
  padding: 4px 10px;
  border: 0;
  background: rgb(255 255 255 / 0.05);
  color: inherit;
  font-family: inherit;
  font-size: 0.8em;
  cursor: pointer;
}

.lv-mode-btn + .lv-mode-btn {
  border-left: 1px solid var(--bt-border, rgb(255 255 255 / 0.12));
}

.lv-mode-btn:hover,
.lv-reset:hover {
  background: rgb(255 255 255 / 0.13);
}

.lv-mode-btn.on {
  background: rgb(137 180 250 / 0.3);
  color: #cddcff;
}

.lv-reset {
  flex: none;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.12));
  border-radius: 8px;
}

.lv-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
}

.lv-group-title {
  min-width: 2.4em;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.78em;
}

.lv-hint {
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.76em;
  opacity: 0.85;
}

.lv-tips {
  margin: 0 0 8px;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.76em;
  line-height: 1.5;
  opacity: 0.85;
}

.lv-chip {
  padding: 3px 10px;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.12));
  border-radius: 999px;
  background: rgb(255 255 255 / 0.05);
  color: inherit;
  font-family: inherit;
  font-size: 0.82em;
  cursor: pointer;
}

.lv-chip:hover {
  background: rgb(255 255 255 / 0.13);
}

.lv-chip.on {
  border-color: rgb(137 180 250 / 0.55);
  background: rgb(137 180 250 / 0.24);
  color: #cddcff;
}

.lv-chip em {
  margin-left: 4px;
  font-style: normal;
  opacity: 0.7;
}

.lv-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: min(56vh, 460px);
  overflow-y: auto;
}

.lv-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 7px;
  background: rgb(255 255 255 / 0.035);
  font-size: 0.86em;
  line-height: 1.5;
}

.lv-turn {
  flex: none;
  width: 2.2em;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.9em;
}

.lv-label {
  flex: none;
  min-width: 3.4em;
  padding: 1px 6px;
  border-radius: 5px;
  background: rgb(255 255 255 / 0.09);
  font-size: 0.86em;
  text-align: center;
}

.lv-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
  white-space: pre-wrap;
}

/* 来源配色 */
.lv-src-OP .lv-label {
  background: rgb(137 180 250 / 0.22);
  color: #cddcff;
}

.lv-src-AI .lv-label {
  background: rgb(203 166 247 / 0.24);
  color: #cba6f7;
}

.lv-src-AI .lv-text {
  color: #e3d7fb;
}

/* 引擎类别配色 */
.lv-kind-COMBAT .lv-label {
  background: rgb(243 139 168 / 0.22);
  color: #f38ba8;
}

.lv-kind-EFFECT .lv-label {
  background: rgb(166 227 161 / 0.2);
  color: #a6e3a1;
}

.lv-kind-ZONE .lv-label {
  background: rgb(249 226 175 / 0.18);
  color: #f9e2af;
}

.lv-kind-STATUS .lv-label {
  background: rgb(250 179 135 / 0.2);
  color: #fab387;
}

.lv-kind-MODIFY .lv-label {
  background: rgb(148 226 213 / 0.2);
  color: #94e2d5;
}

/* 日志等级: 警告 / 错误整行标出来, INFO / DEBUG 只用于筛选 */
.lv-lv-WARN {
  background: rgb(249 226 175 / 0.1);
  box-shadow: inset 2px 0 0 rgb(249 226 175 / 0.7);
}

.lv-lv-ERROR {
  background: rgb(243 139 168 / 0.14);
  box-shadow: inset 2px 0 0 rgb(243 139 168 / 0.85);
}

.lv-level {
  flex: none;
  padding: 1px 6px;
  border-radius: 5px;
  background: rgb(255 255 255 / 0.1);
  font-size: 0.82em;
}

.lv-lv-WARN .lv-level {
  background: rgb(249 226 175 / 0.22);
  color: #f9e2af;
}

.lv-lv-ERROR .lv-level {
  background: rgb(243 139 168 / 0.24);
  color: #f38ba8;
}

/* 引擎内部问题: 面板能看到, 但不会发进简报 */
.lv-internal {
  flex: none;
  padding: 1px 6px;
  border-radius: 5px;
  background: rgb(255 255 255 / 0.07);
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.78em;
}

.lv-empty {
  margin: 22px 0;
  color: var(--bt-text-secondary, #a0a0b0);
  text-align: center;
  font-size: 0.88em;
}
</style>
