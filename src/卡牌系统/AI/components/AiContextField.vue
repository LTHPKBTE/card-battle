<!-- AI 上下文开关: 明确告诉用户这次请求会不会带上聊天记录、带多少条 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <div class="ai-ctx">
    <label class="ai-ctx-switch">
      <input type="checkbox" :checked="enabled" @change="onToggle" />
      <span>带入最近聊天记录</span>
    </label>
    <label v-if="enabled" class="ai-ctx-count">
      <span>条数</span>
      <NumberField
        class="ai-ctx-input"
        :model-value="count"
        :min="1"
        :max="200"
        :fallback="30"
        @update:model-value="emit('update:count', $event)"
      />
    </label>
    <span class="ai-ctx-hint">{{ hint }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import NumberField from '../../共用/NumberField.vue';

const props = defineProps<{
  /** 是否带入聊天记录 */
  enabled: boolean;
  /** 带入的条数 */
  count: number;
}>();

const emit = defineEmits<{
  'update:enabled': [value: boolean];
  'update:count': [value: number];
}>();

const safeCount = computed(() => {
  const value = Math.trunc(Number(props.count));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 200) : 30;
});

const hint = computed(() =>
  props.enabled
    ? `会读取最近 ${safeCount.value} 条聊天记录, 让生成内容贴合当前剧情`
    : '不带聊天记录, 只按卡牌信息生成',
);

function onToggle(event: Event) {
  emit('update:enabled', (event.target as HTMLInputElement).checked);
}
</script>

<style lang="scss" scoped>
.ai-ctx {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  font-size: 0.85em;
}

.ai-ctx-switch,
.ai-ctx-count {
  display: flex;
  align-items: center;
  gap: 6px;
  color: rgb(255 255 255 / 0.78);
  cursor: pointer;
}

.ai-ctx-switch input[type='checkbox'] {
  width: 15px;
  height: 15px;
  accent-color: #89b4fa;
  cursor: pointer;
}

.ai-ctx-count {
  cursor: default;
  color: rgb(255 255 255 / 0.55);
}

.ai-ctx-input {
  box-sizing: border-box;
  width: 72px;
  border: 1px solid rgb(255 255 255 / 0.15);
  border-radius: 6px;
  background: rgb(0 0 0 / 0.25);
  color: #f0f0f5;
  font-family: inherit;
  font-size: 1em;
  padding: 4px 6px;
  outline: none;
}

.ai-ctx-input:focus {
  border-color: #89b4fa;
}

.ai-ctx-hint {
  flex-basis: 100%;
  font-size: 0.9em;
  color: rgb(255 255 255 / 0.42);
  line-height: 1.5;
}
</style>
