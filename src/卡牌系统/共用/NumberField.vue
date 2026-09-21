<!-- 数字输入框: 编辑期间不校验不写回 (可完全删空), 失焦/回车/change 时才规范化并提交 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <input
    ref="inputRef"
    v-bind="$attrs"
    type="number"
    :value="text"
    :min="min"
    :max="max"
    :step="integer ? 1 : 'any'"
    @focus="focused = true"
    @input="onInput"
    @change="commit"
    @blur="onBlur"
    @keydown.enter.prevent="onEnter"
  />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { resolveNumberInput, type NumberInputOptions } from './数字';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    /** 已提交的数值 */
    modelValue: number;
    /** 允许的最小值 */
    min?: number;
    /** 允许的最大值 */
    max?: number;
    /** 是否只允许整数 (默认 true) */
    integer?: boolean;
    /** 清空或填了非法内容时回退到的值 (默认 min ?? 0) */
    fallback?: number;
  }>(),
  { min: undefined, max: undefined, integer: true, fallback: undefined },
);

const emit = defineEmits<{ 'update:modelValue': [value: number] }>();

const inputRef = ref<HTMLInputElement | null>(null);
/** 输入框里的原始文本: 编辑期间原样保留, 因此可以完全删空 */
const text = ref(String(props.modelValue));
/** 是否正在编辑 (编辑期间不被外部值覆盖) */
const focused = ref(false);

function options(): NumberInputOptions {
  return { min: props.min, max: props.max, integer: props.integer, fallback: props.fallback };
}

/** 规范化并写回: 清空或非法时用回退值 */
function commit() {
  const value = resolveNumberInput(text.value, options());
  text.value = String(value);
  if (value !== props.modelValue) {
    emit('update:modelValue', value);
  }
}

function onInput(event: Event) {
  text.value = (event.target as HTMLInputElement).value;
}

function onBlur() {
  focused.value = false;
  commit();
}

function onEnter() {
  commit();
  inputRef.value?.blur();
}

// 外部改动 (切换对象 / 重置) 时同步, 但不打断正在输入的用户
watch(
  () => props.modelValue,
  value => {
    if (!focused.value) {
      text.value = String(value);
    }
  },
);

defineExpose({ commit });
</script>
