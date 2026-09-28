<!-- 数据面板: 备份 / 恢复 / 清空 (导出与导入留在卡牌库与卡组面板里) -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <div class="dt-overlay" :style="lookStyle">
    <div class="dt-main">
      <header class="dt-header">
        <div class="dt-titles">
          <span class="dt-title">数据</span>
          <span class="dt-count">{{ cards.length }} 张卡牌 · {{ decks.length }} 套卡组</span>
        </div>
        <button class="dt-btn" type="button" :class="{ primary: showLook }" @click="showLook = !showLook">
          外观
        </button>
        <button class="dt-close" type="button" @click="requestClose">✕ 关闭</button>
      </header>

      <!-- 垫底色 / 模糊半径 (各面板共用同一份设置) -->
      <PanelLookSettings v-if="showLook" @close="showLook = false" />

      <div class="dt-body">
        <p v-if="errorMessage" class="dt-banner error">{{ errorMessage }}</p>
        <p v-else-if="resultMessage" class="dt-banner">{{ resultMessage }}</p>

        <!-- ============ 备份 / 恢复 ============ -->
        <section class="dt-sec">
          <div class="dt-sec-head">
            <span class="dt-sec-title">备份与恢复</span>
            <span class="dt-sec-note">自己留档用: 连「放在哪儿」一起存, 换设备 / 换角色卡后还能恢复</span>
          </div>
          <div class="dt-row">
            <div class="dt-row-main">
              <span class="dt-row-name">备份</span>
              <span class="dt-row-note">
                把现在的 {{ cards.length }} 张卡牌、{{ decks.length }} 套卡组存成一个文件; 发给自己或换个地方用
              </span>
            </div>
            <button class="dt-btn" type="button" :disabled="busy" @click="doBackup">备份…</button>
          </div>
          <div class="dt-row">
            <div class="dt-row-main">
              <span class="dt-row-name">恢复</span>
              <span class="dt-row-note">从备份文件放回来; 备份里的位置在这台设备上没有时会先问你</span>
            </div>
            <button class="dt-btn" type="button" :disabled="busy" @click="doRestore">从备份恢复…</button>
          </div>
        </section>

        <!-- ============ 清空 ============ -->
        <section class="dt-sec">
          <div class="dt-sec-head">
            <span class="dt-sec-title">清空</span>
            <span class="dt-sec-note">勾选要清掉的区域, 确认 (5 秒倒数) 后才会动手, 不可撤销</span>
            <span class="dt-spacer" />
            <button class="dt-btn small" type="button" @click="全选可用">
              {{ 全选了吗 ? '取消全选' : '全选' }}
            </button>
          </div>

          <div class="dt-regions">
            <label
              v-for="region in regions"
              :key="region.key"
              class="dt-region"
              :class="{ 'is-off': !region.可用, 'is-on': checked.includes(region.key) }"
            >
              <input
                type="checkbox"
                :checked="checked.includes(region.key)"
                :disabled="!region.可用"
                @change="toggle(region.key)"
              />
              <span class="dt-region-text">
                <span class="dt-region-head">
                  <span class="dt-region-range">{{ region.范围 }}</span>
                  <span class="dt-region-name">{{ region.标题 }}</span>
                  <span class="dt-tag">{{ region.可用 ? region.内容 : region.原因 }}</span>
                </span>
                <span class="dt-region-note">{{ region.影响 }}</span>
              </span>
            </label>
          </div>

          <div class="dt-actions">
            <button
              class="dt-btn danger"
              type="button"
              :disabled="busy || checked.length === 0"
              @click="doClear"
            >
              清空选中的 {{ checked.length }} 项
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';

import PanelLookSettings from '../共用/PanelLookSettings.vue';
import { requestPanelClose } from '../共用/面板';
import { onPanelLookChanged, panelLookStyle, loadPanelLook, flushPanelLookSave, type PanelLook } from '../共用/外观';
import { loadCards } from '../卡牌/data';
import { loadDecks } from '../卡组/data';
import { resetRegions, runClear, hasAnySource, type ResetKey } from '../重置';
import { runBackupExport, runBackupImport } from './流程';

// ---- 外观 ----
const showLook = ref(false);
const look = ref<PanelLook>(loadPanelLook());
const lookStyle = computed(() => panelLookStyle(look.value));
const off_look = onPanelLookChanged(() => {
  look.value = loadPanelLook();
});

// ---- 内容 ----
const cards = ref(loadCards());
const decks = ref(loadDecks());
const regions = ref(resetRegions());
const checked = ref<ResetKey[]>([]);
const busy = ref(false);
const resultMessage = ref('');
const errorMessage = ref('');

function refresh() {
  try {
    cards.value = loadCards();
    decks.value = loadDecks();
    regions.value = resetRegions();
    errorMessage.value = '';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
  // 勾选里已经没有的区域 (例如换了角色卡) 一并去掉
  const 可用 = new Set(regions.value.filter(region => region.可用).map(region => region.key));
  checked.value = checked.value.filter(key => 可用.has(key));
}

const 可选 = computed(() => regions.value.filter(region => region.可用));
const 全选了吗 = computed(() => 可选.value.length > 0 && checked.value.length === 可选.value.length);

function toggle(key: ResetKey) {
  checked.value = checked.value.includes(key) ? checked.value.filter(item => item !== key) : [...checked.value, key];
}

function 全选可用() {
  checked.value = 全选了吗.value ? [] : 可选.value.map(region => region.key);
}

// ---- 三个动作 ----

async function withBusy(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  resultMessage.value = '';
  try {
    await action();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
    refresh();
  }
}

function doBackup(): void {
  void withBusy(async () => {
    if (await runBackupExport('数据')) {
      resultMessage.value = '备份文件已下载。';
    }
  });
}

function doRestore(): void {
  void withBusy(async () => {
    if (await runBackupImport('数据')) {
      resultMessage.value = '已按备份恢复。';
    }
  });
}

function doClear(): void {
  void withBusy(async () => {
    if (await runClear(checked.value, '数据')) {
      resultMessage.value = `已清空 ${checked.value.length} 个区域。`;
      checked.value = [];
    }
  });
}

function requestClose() {
  flushPanelLookSave();
  requestPanelClose('数据');
}

refresh();
if (!hasAnySource()) {
  errorMessage.value = '现在既没有角色卡也没有对话, 卡牌与卡组都读不到。';
}

onUnmounted(() => {
  off_look();
});
</script>

<style lang="scss" scoped>
.dt-overlay {
  --dt-panel: rgb(var(--panel-tint, 22 24 33) / var(--panel-alpha, 0.92));
  --dt-border: rgb(255 255 255 / 0.1);
  --dt-text: #f0f0f5;
  --dt-text-secondary: #a0a0b0;
  --dt-accent: #89b4fa;

  color-scheme: dark;

  position: fixed;
  inset: 0;
  /* 酒馆 style.css 里有 `html{transform: translateZ(0px)}` —— 恒等变换同样会让 html 成为
     fixed 子元素的包含块; 而窄屏时酒馆又把 body 设为 position:fixed, body 脱离文档流后
     html 高度塌缩为 0, 于是 inset:0 会按「高度为 0 的包含块」解算, 面板塌成一条线。
     这里用视口单位兜住高度(视口单位不受包含块影响), 任何宽度下都成立。 */
  height: 100vh;
  height: 100dvh;
  z-index: 2147483000;
  display: flex;
  padding: 24px;
  box-sizing: border-box;
  background: var(--panel-mask, rgb(8 9 13 / 0.28));
  color: var(--dt-text);
  font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  overflow: auto;
}

.dt-main {
  width: 100%;
  max-width: 760px;
  min-width: 0;
  margin: auto;
  position: relative;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dt-border);
  border-radius: 16px;
  background: var(--dt-panel);
  backdrop-filter: blur(var(--panel-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-blur, 10px));
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.6);
  overflow: hidden;
}

.dt-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--dt-border);
}

.dt-titles {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.dt-title {
  font-size: 1.25em;
  font-weight: 700;
  letter-spacing: 1px;
}

.dt-count {
  color: var(--dt-text-secondary);
  font-size: 0.82em;
}

.dt-spacer {
  flex: 1;
}

.dt-btn {
  padding: 5px 12px;
  border: 1px solid var(--dt-border);
  border-radius: 9px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  font-size: 0.86em;
  cursor: pointer;
}

.dt-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.15);
}

.dt-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.dt-btn.small {
  font-size: 0.8em;
}

.dt-btn.primary {
  border-color: rgb(137 180 250 / 0.55);
  background: rgb(137 180 250 / 0.22);
}

.dt-btn.danger {
  border-color: rgb(243 139 168 / 0.5);
  background: rgb(243 139 168 / 0.18);
}

.dt-close {
  padding: 5px 12px;
  border: 1px solid var(--dt-border);
  border-radius: 9px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  font-size: 0.86em;
  cursor: pointer;
}

.dt-close:hover {
  background: rgb(243 139 168 / 0.25);
}

.dt-body {
  flex: 1;
  padding: 16px 18px 22px;
  overflow-y: auto;
}

.dt-banner {
  margin: 0 0 14px;
  padding: 9px 12px;
  border: 1px solid rgb(137 180 250 / 0.35);
  border-radius: 10px;
  background: rgb(137 180 250 / 0.12);
  font-size: 0.86em;
  line-height: 1.6;
}

.dt-banner.error {
  border-color: rgb(243 139 168 / 0.4);
  background: rgb(243 139 168 / 0.12);
}

.dt-sec {
  margin-bottom: 18px;
  padding: 12px 14px;
  border: 1px solid var(--dt-border);
  border-radius: 12px;
  background: rgb(255 255 255 / 0.035);
}

.dt-sec-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.dt-sec-title {
  font-size: 0.98em;
  font-weight: 700;
}

.dt-sec-note {
  color: var(--dt-text-secondary);
  font-size: 0.76em;
}

.dt-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;

  & + & {
    border-top: 1px solid rgb(255 255 255 / 0.06);
  }
}

.dt-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.dt-row-name {
  font-size: 0.92em;
  font-weight: 600;
}

.dt-row-note {
  color: var(--dt-text-secondary);
  font-size: 0.78em;
  line-height: 1.5;
}

.dt-tag {
  padding: 1px 9px;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.08);
  color: var(--dt-text-secondary);
  font-size: 0.76em;
  white-space: nowrap;
}

.dt-regions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.dt-region {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 9px 10px;
  border: 1px solid var(--dt-border);
  border-radius: 10px;
  background: rgb(255 255 255 / 0.03);
  cursor: pointer;
}

.dt-region.is-on {
  border-color: rgb(243 139 168 / 0.45);
  background: rgb(243 139 168 / 0.1);
}

.dt-region.is-off {
  opacity: 0.5;
  cursor: not-allowed;
}

.dt-region input {
  margin-top: 3px;
  accent-color: #f38ba8;
}

.dt-region-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.dt-region-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.dt-region-range {
  padding: 0 6px;
  border-radius: 5px;
  background: rgb(255 255 255 / 0.08);
  color: var(--dt-text-secondary);
  font-size: 0.72em;
}

.dt-region-name {
  font-size: 0.9em;
  font-weight: 600;
}

.dt-region-note {
  color: var(--dt-text-secondary);
  font-size: 0.76em;
  line-height: 1.5;
}

.dt-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

@media (max-width: 560px) {
  .dt-overlay {
    padding: 12px;
  }

  .dt-regions {
    grid-template-columns: 1fr;
  }
}
</style>
