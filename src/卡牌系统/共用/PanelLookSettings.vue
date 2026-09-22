<!-- 面板外观设置条: 垫底色 / 不透明度 / 高斯模糊半径 + 弹窗的两档 (卡牌库 / 卡组 / 战斗 共用) -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <div class="plk">
    <label class="plk-field">
      <span class="plk-label">垫底色</span>
      <input class="plk-color" type="color" :value="look.垫底色" @input="onColorPick" />
      <input
        v-model="colorText"
        class="plk-text"
        type="text"
        maxlength="7"
        spellcheck="false"
        placeholder="#0e1015"
        @change="onColorText"
        @blur="onColorText"
      />
    </label>

    <label class="plk-field">
      <span class="plk-label">不透明度</span>
      <input
        class="plk-range"
        type="range"
        min="0"
        max="1"
        step="0.02"
        :value="look.不透明度"
        @input="onAlpha"
      />
      <b class="plk-value">{{ look.不透明度.toFixed(2) }}</b>
    </label>

    <label class="plk-field">
      <span class="plk-label">模糊半径</span>
      <input
        class="plk-range"
        type="range"
        min="0"
        :max="MAX_PANEL_BLUR"
        step="1"
        :value="look.模糊半径"
        @input="onBlur"
      />
      <b class="plk-value">{{ look.模糊半径 }}px</b>
    </label>

    <label class="plk-field" title="面板里的信息弹窗 (卡牌详情 / 设置 / 调试 / 日志 / 回放) 的不透明度">
      <span class="plk-label">弹窗不透明度</span>
      <input
        class="plk-range"
        type="range"
        min="0"
        max="1"
        step="0.02"
        :value="look.弹窗不透明度"
        @input="onDialogAlpha"
      />
      <b class="plk-value">{{ look.弹窗不透明度.toFixed(2) }}</b>
    </label>

    <label class="plk-field" title="面板里的信息弹窗的虚化程度">
      <span class="plk-label">弹窗模糊</span>
      <input
        class="plk-range"
        type="range"
        min="0"
        :max="MAX_DIALOG_BLUR"
        step="1"
        :value="look.弹窗模糊半径"
        @input="onDialogBlur"
      />
      <b class="plk-value">{{ look.弹窗模糊半径 }}px</b>
    </label>

    <div class="plk-actions">
      <span class="plk-hint">面板透出后面的聊天内容, 由模糊半径决定虚化程度; 弹窗要读字, 默认更实</span>
      <button class="plk-btn" type="button" @click="reset">恢复默认</button>
      <button class="plk-btn" type="button" @click="emit('close')">收起</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

import {
  MAX_DIALOG_BLUR,
  MAX_PANEL_BLUR,
  defaultPanelLook,
  flushPanelLookSave,
  loadPanelLook,
  normalizeHex,
  onPanelLookChanged,
  savePanelLook,
  type PanelLook,
} from './外观';

const emit = defineEmits<{ close: [] }>();

const look = ref<PanelLook>(loadPanelLook());
/** 十六进制输入框的中间态: 打字过程中不立刻回写, 失焦/回车才校验 */
const colorText = ref(look.value.垫底色);

function apply(partial: Partial<PanelLook>) {
  look.value = savePanelLook(partial);
  colorText.value = look.value.垫底色;
}

function onColorPick(event: Event) {
  apply({ 垫底色: (event.target as HTMLInputElement).value });
}

function onColorText() {
  const normalized = normalizeHex(colorText.value);
  if (!normalized) {
    colorText.value = look.value.垫底色;
    return;
  }
  apply({ 垫底色: normalized });
}

function onAlpha(event: Event) {
  apply({ 不透明度: Number((event.target as HTMLInputElement).value) });
}

function onBlur(event: Event) {
  apply({ 模糊半径: Number((event.target as HTMLInputElement).value) });
}

function onDialogAlpha(event: Event) {
  apply({ 弹窗不透明度: Number((event.target as HTMLInputElement).value) });
}

function onDialogBlur(event: Event) {
  apply({ 弹窗模糊半径: Number((event.target as HTMLInputElement).value) });
}

function reset() {
  apply(defaultPanelLook());
}

// 别的面板改了外观时同步过来 (色值输入框由下面的 watch 单独处理, 不覆盖半截输入)
const off = onPanelLookChanged(() => {
  look.value = loadPanelLook();
});

watch(
  () => look.value.垫底色,
  value => {
    if (normalizeHex(colorText.value) !== value) {
      colorText.value = value;
    }
  },
);

onBeforeUnmount(() => {
  off();
  flushPanelLookSave();
});
</script>

<style scoped>
.plk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
  padding: 10px 16px;
  border-bottom: 1px solid rgb(255 255 255 / 0.1);
  background: rgb(255 255 255 / 0.03);
  font-size: 0.84em;
}

.plk-field {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.plk-label {
  color: var(--plk-secondary, #a0a0b0);
  white-space: nowrap;
}

.plk-color {
  width: 30px;
  height: 22px;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 0.16);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.plk-text {
  width: 82px;
  box-sizing: border-box;
  padding: 4px 6px;
  border: 1px solid rgb(255 255 255 / 0.16);
  border-radius: 6px;
  background: rgb(0 0 0 / 0.3);
  color: inherit;
  font-family: inherit;
  font-size: 0.95em;
  font-variant-numeric: tabular-nums;
  outline: none;
}

.plk-text:focus {
  border-color: #89b4fa;
}

.plk-range {
  width: 110px;
  margin: 0;
  accent-color: #89b4fa;
  cursor: pointer;
}

.plk-value {
  min-width: 44px;
  font-variant-numeric: tabular-nums;
}

.plk-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.plk-hint {
  color: var(--plk-secondary, #a0a0b0);
  font-size: 0.94em;
}

.plk-btn {
  padding: 4px 10px;
  border: 1px solid rgb(255 255 255 / 0.16);
  border-radius: 7px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  font-size: 0.95em;
  cursor: pointer;
}

.plk-btn:hover {
  background: rgb(255 255 255 / 0.14);
}
</style>
