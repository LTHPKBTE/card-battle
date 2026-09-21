<!-- 写卡 AI 接口设置: 一行灰色小字 + 展开的接口表单 (卡牌库/卡组/卡牌编辑器共用) -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <div class="ai-cfg">
    <button class="ai-cfg-hint" type="button" @click="toggle">
      写卡用的 AI: {{ label }} · 点击更换
    </button>

    <div v-if="open" class="ai-cfg-form">
      <label class="ai-cfg-field">
        <span class="ai-cfg-label">接口</span>
        <select v-model="form.模式" class="ai-cfg-input">
          <option v-for="mode in AI_MODES" :key="mode" :value="mode">{{ mode }}</option>
        </select>
      </label>
      <p class="ai-cfg-mode-hint">{{ AI_MODE_HINTS[form.模式] }}</p>

      <label v-if="form.模式 === '预设'" class="ai-cfg-field">
        <span class="ai-cfg-label">预设名</span>
        <input
          v-model.trim="form.预设名"
          class="ai-cfg-input"
          list="ai-cfg-presets"
          type="text"
          placeholder="酒馆里保存的代理预设名"
        />
        <datalist id="ai-cfg-presets">
          <option v-for="name in presetNames" :key="name" :value="name" />
        </datalist>
      </label>

      <template v-if="form.模式 === '自定义'">
        <label class="ai-cfg-field">
          <span class="ai-cfg-label">接口地址</span>
          <input v-model.trim="form.接口地址" class="ai-cfg-input" type="text" placeholder="https://example.com/v1" />
        </label>
        <label class="ai-cfg-field">
          <span class="ai-cfg-label">密钥</span>
          <input v-model="form.密钥" class="ai-cfg-input" type="password" placeholder="sk-…" />
        </label>
        <label class="ai-cfg-field">
          <span class="ai-cfg-label">接口类型</span>
          <input v-model.trim="form.接口类型" class="ai-cfg-input" list="ai-cfg-sources" type="text" placeholder="openai" />
          <datalist id="ai-cfg-sources">
            <option v-for="source in AI_SOURCE_CHOICES" :key="source" :value="source" />
          </datalist>
        </label>
      </template>

      <label v-if="form.模式 !== '当前'" class="ai-cfg-field">
        <span class="ai-cfg-label">模型</span>
        <input
          v-model.trim="form.模型"
          class="ai-cfg-input"
          list="ai-cfg-models"
          type="text"
          placeholder="留空 = 用接口默认模型"
        />
        <datalist id="ai-cfg-models">
          <option v-for="name in models" :key="name" :value="name" />
        </datalist>
      </label>

      <div v-if="form.模式 !== '当前'" class="ai-cfg-field ai-cfg-tune">
        <span class="ai-cfg-label">温度</span>
        <input v-model="temperatureText" class="ai-cfg-input" type="text" placeholder="留空 = 默认" />
        <span class="ai-cfg-label">回复长度</span>
        <input v-model="maxTokensText" class="ai-cfg-input" type="text" placeholder="留空 = 默认" />
      </div>

      <div class="ai-cfg-actions">
        <button class="ai-cfg-btn primary" type="button" @click="save">保存</button>
        <button v-if="form.模式 === '自定义'" class="ai-cfg-btn" type="button" :disabled="modelsBusy" @click="fetchModels">
          {{ modelsBusy ? '获取中…' : '获取模型列表' }}
        </button>
        <button class="ai-cfg-btn" type="button" @click="reset">恢复默认</button>
        <span v-if="note" class="ai-cfg-note">{{ note }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  AI_MODE_HINTS,
  AI_MODES,
  AI_SOURCE_CHOICES,
  defaultAiSettings,
  describeAiSettings,
  listModels,
  listProxyPresets,
  loadAiSettings,
  onAiSettingsChanged,
  saveAiSettings,
  type AiSettings,
} from '../设置';

const open = ref(false);
/** 已保存的设置 (用于灰色小字) */
const saved = ref<AiSettings>(defaultAiSettings());
/** 表单草稿 */
const form = ref<AiSettings>(defaultAiSettings());
const temperatureText = ref('');
const maxTokensText = ref('');
const models = ref<string[]>([]);
const presetNames = ref<string[]>([]);
const modelsBusy = ref(false);
const note = ref('');

const label = computed(() => describeAiSettings(saved.value));

function textOf(value: number | null): string {
  return value === null ? '' : String(value);
}

/** 把输入框文本转成可选数字, 不合法时抛出可读的错误 */
function numberOrNull(text: string, options: { min?: number; max?: number; integer?: boolean }): number | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(`「${trimmed}」不是数字`);
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new Error('回复长度需要是整数');
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`数值不能小于 ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`数值不能大于 ${options.max}`);
  }
  return value;
}

function syncForm(settings: AiSettings) {
  form.value = { ...settings };
  temperatureText.value = textOf(settings.温度);
  maxTokensText.value = textOf(settings.最大回复长度);
}

function toggle() {
  if (!open.value) {
    saved.value = loadAiSettings();
    syncForm(saved.value);
    note.value = '';
    if (presetNames.value.length === 0) {
      presetNames.value = listProxyPresets();
    }
  }
  open.value = !open.value;
}

function save() {
  try {
    const next = saveAiSettings({
      ...form.value,
      温度: numberOrNull(temperatureText.value, { min: 0, max: 2 }),
      最大回复长度: numberOrNull(maxTokensText.value, { min: 1, integer: true }),
    });
    saved.value = next;
    syncForm(next);
    note.value = '已保存';
  } catch (error) {
    note.value = error instanceof Error ? error.message : String(error);
  }
}

function reset() {
  const next = saveAiSettings(defaultAiSettings());
  saved.value = next;
  syncForm(next);
  note.value = '已恢复默认';
}

async function fetchModels() {
  note.value = '';
  modelsBusy.value = true;
  try {
    models.value = await listModels(form.value.接口地址, form.value.密钥);
    note.value = models.value.length ? `已获取 ${models.value.length} 个模型` : '没有获取到模型';
  } catch (error) {
    note.value = error instanceof Error ? error.message : String(error);
  } finally {
    modelsBusy.value = false;
  }
}

onMounted(() => {
  saved.value = loadAiSettings();
  syncForm(saved.value);
  presetNames.value = listProxyPresets();
});

/** 其他面板改了设置时, 同步本面板的灰字 (同一个模块实例, 直接订阅即可) */
const off_settings_changed = onAiSettingsChanged(() => {
  saved.value = loadAiSettings();
  if (!open.value) {
    syncForm(saved.value);
  }
});

onBeforeUnmount(off_settings_changed);
</script>

<style lang="scss" scoped>
.ai-cfg {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai-cfg-hint {
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

.ai-cfg-hint:hover {
  color: rgb(255 255 255 / 0.75);
  text-decoration: underline;
}

.ai-cfg-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid rgb(255 255 255 / 0.14);
  border-radius: 8px;
  background: rgb(0 0 0 / 0.22);
}

.ai-cfg-field {
  display: grid;
  grid-template-columns: 66px minmax(0, 1fr);
  align-items: center;
  gap: 6px 8px;
}

.ai-cfg-label {
  font-size: 0.82em;
  color: var(--dk-text-secondary, #a0a0b0);
}

.ai-cfg-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  border: 1px solid rgb(255 255 255 / 0.18);
  border-radius: 6px;
  background: rgb(0 0 0 / 0.28);
  color: inherit;
  font-family: inherit;
  font-size: 0.88em;
  padding: 5px 8px;
  outline: none;
}

.ai-cfg-input:focus {
  border-color: #89b4fa;
}

.ai-cfg-input option {
  background: #1c1e27;
  color: #f0f0f5;
}

.ai-cfg-mode-hint {
  margin: 0;
  font-size: 0.76em;
  line-height: 1.5;
  color: rgb(255 255 255 / 0.42);
}

.ai-cfg-tune {
  grid-template-columns: 46px minmax(0, 1fr) 62px minmax(0, 1fr);
}

.ai-cfg-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ai-cfg-btn {
  border: 1px solid rgb(255 255 255 / 0.2);
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  border-radius: 6px;
  padding: 4px 10px;
  font-family: inherit;
  font-size: 0.82em;
  cursor: pointer;
}

.ai-cfg-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.14);
}

.ai-cfg-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.ai-cfg-btn.primary {
  border-color: rgb(137 180 250 / 0.55);
  background: rgb(137 180 250 / 0.16);
  color: #89b4fa;
}

.ai-cfg-note {
  font-size: 0.78em;
  color: rgb(255 255 255 / 0.5);
}
</style>
