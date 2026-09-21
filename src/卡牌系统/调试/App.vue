<!-- 全局调试面板: 看看变量里到底存了什么、各占多少, 以及最近的运行痕迹 (通知) -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <div class="dbg-overlay" :class="{ 'is-narrow': isNarrow }" :style="lookStyle">
    <div class="dbg-main">
      <header class="dbg-header">
        <span class="dbg-title">调试</span>
        <span class="dbg-sub">变量占用 · 运行痕迹</span>
        <span class="dbg-spacer" />
        <button class="dbg-btn" type="button" title="重新量一遍 (卡牌库很大时会有一下卡顿)" @click="reload">
          刷新
        </button>
        <button class="dbg-btn" type="button" :class="{ primary: showLook }" @click="showLook = !showLook">
          外观
        </button>
        <button class="dbg-close" type="button" @click="requestClose">✕ 关闭</button>
      </header>

      <!-- 垫底色 / 模糊半径 (各面板共用同一份设置) -->
      <PanelLookSettings v-if="showLook" @close="showLook = false" />

      <div class="dbg-body">
        <p class="dbg-tip">
          量的是「变量整份 JSON 的字符数」—— 酒馆把变量序列化后存进聊天文件，所以这个数字就是真实代价。
          排查异常占用时看下面两张表：先看哪个命名空间大，再钻到具体是哪一条把它撑起来的。
        </p>

        <div v-if="errorMessage" class="dbg-banner">
          <span>读取变量失败: {{ errorMessage }}</span>
          <button class="dbg-btn small" type="button" @click="reload">重试</button>
        </div>

        <!-- ============ 环境 ============ -->
        <section class="dbg-sec">
          <div class="dbg-sec-head">
            <span class="dbg-sec-title">环境</span>
          </div>
          <div class="dbg-kv">
            <span v-for="row in env" :key="row.标签"><b>{{ row.标签 }}</b>{{ row.值 }}</span>
          </div>
        </section>

        <!-- ============ 三个作用域 ============ -->
        <section v-for="scope in scopes" :key="scope.key" class="dbg-sec">
          <div class="dbg-sec-head">
            <span class="dbg-sec-title">{{ scope.标题 }}</span>
            <span class="dbg-tag" :class="scope.可读 ? 'ok' : 'warn'">
              {{ scope.可读 ? formatSize(scope.合计) : '暂时读不到' }}
            </span>
            <span class="dbg-sec-note">{{ scope.说明 }}</span>
          </div>

          <p v-if="scope.错误" class="dbg-warn">读取失败: {{ scope.错误 }}</p>

          <template v-if="scope.可读">
            <p v-if="scope.顶层.length === 0" class="dbg-empty">这个作用域里还没有任何变量。</p>
            <template v-else>
              <div class="dbg-sub-title">顶层命名空间</div>
              <div v-for="row in scope.顶层" :key="row.路径" class="dbg-row">
                <span class="dbg-name" :title="row.路径">{{ row.路径 }}</span>
                <span class="dbg-bar">
                  <i :style="{ width: barWidth(row.字符数, scope.合计) }" />
                </span>
                <span class="dbg-size">{{ formatSize(row.字符数) }}</span>
                <span class="dbg-meta">{{ row.类型 }}</span>
              </div>

              <div class="dbg-sub-title">
                占用最大的条目
                <span class="dbg-hint">最多列出 {{ DEBUG_LEAF_LIMIT }} 条，往下钻到第 {{ DEBUG_LEAF_DEPTH }} 层</span>
              </div>
              <div v-for="row in scope.叶子" :key="row.路径" class="dbg-row leaf">
                <span class="dbg-name" :title="row.路径">{{ row.路径 || '(空)' }}</span>
                <span class="dbg-size">{{ formatSize(row.字符数) }}</span>
                <span class="dbg-meta">{{ row.类型 }}</span>
              </div>
            </template>

            <button class="dbg-btn small" type="button" @click="toggleJson(scope.key)">
              {{ expanded.includes(scope.key) ? '收起完整 JSON' : '查看完整 JSON' }}
              <template v-if="scope.json_truncated">(已截断展示)</template>
            </button>
            <pre v-if="expanded.includes(scope.key)" class="dbg-pre">{{ scope.json }}</pre>
          </template>
        </section>

        <!-- ============ 通知留档 ============ -->
        <section class="dbg-sec">
          <div class="dbg-sec-head">
            <span class="dbg-sec-title">最近的通知</span>
            <span class="dbg-tag">{{ notifications.length }} 条</span>
            <span class="dbg-sec-note">回退、提示条都在这里; 关掉提示条也能回看</span>
            <span class="dbg-spacer" />
            <button class="dbg-btn small" type="button" :disabled="notifications.length === 0" @click="clearNotify">
              清空
            </button>
          </div>
          <p v-if="notifications.length === 0" class="dbg-empty">还没有发过通知。</p>
          <div v-for="(item, index) in notifications" :key="index" class="dbg-note" :class="item.level ?? 'info'">
            <span class="dbg-note-time">{{ item.at }}</span>
            <span class="dbg-note-title">{{ item.title }}</span>
            <span class="dbg-note-text">{{ item.message }}</span>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';

import PanelLookSettings from '../共用/PanelLookSettings.vue';
import { clearNotifyHistory, notifyHistory, type NotifyRecord } from '../共用/通知';
import { flushPanelLookSave, loadPanelLook, onPanelLookChanged, panelLookStyle, type PanelLook } from '../共用/外观';
import {
  DEBUG_LEAF_DEPTH,
  DEBUG_LEAF_LIMIT,
  collectDebugScopes,
  debugEnvironment,
  formatSize,
  type EnvRow,
  type ScopeReport,
  type ScopeKey,
} from './数据';

const CLOSE_EVENT = 'card-debug-close';
const NARROW_MAX_WIDTH = 900;

// ---- 垫底外观 (各面板共用同一份设置) ----
const showLook = ref(false);
const look = ref<PanelLook>(loadPanelLook());
const lookStyle = computed(() => panelLookStyle(look.value));
const off_look = onPanelLookChanged(() => {
  look.value = loadPanelLook();
});

// ---- 数据 ----
const scopes = ref<ScopeReport[]>([]);
const env = ref<EnvRow[]>([]);
const notifications = ref<NotifyRecord[]>([]);
const errorMessage = ref('');
const expanded = ref<ScopeKey[]>([]);

function reload() {
  errorMessage.value = '';
  try {
    scopes.value = collectDebugScopes();
  } catch (error) {
    // 酒馆助手在欢迎页 / 还没加载完时可能读不到变量, 这时也要能打开面板看通知
    errorMessage.value = error instanceof Error ? error.message : String(error);
    scopes.value = [];
  }
  env.value = debugEnvironment();
  notifications.value = notifyHistory();
}

reload();

/** 展开/收起某个作用域的完整 JSON */
function toggleJson(key: ScopeKey) {
  expanded.value = expanded.value.includes(key)
    ? expanded.value.filter(item => item !== key)
    : [...expanded.value, key];
}

/** 进度条宽度 (占该作用域合计的比例) */
function barWidth(chars: number, total: number): string {
  if (total <= 0 || chars <= 0) {
    return '0%';
  }
  return `${Math.max(2, Math.round((chars / total) * 100))}%`;
}

function clearNotify() {
  clearNotifyHistory();
  notifications.value = [];
}

/** 请求关闭面板 (由入口脚本监听该 DOM 事件并卸载本组件) */
function requestClose() {
  flushPanelLookSave();
  window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
}

// ---- 窄屏适配 (与其它面板一致: 量酒馆主窗口, 不是脚本 iframe) ----
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

const isNarrow = ref(false);
let narrowMq: MediaQueryList | null = null;
function syncNarrow(query: MediaQueryList | MediaQueryListEvent) {
  isNarrow.value = query.matches;
}
if (typeof viewportWindow.matchMedia === 'function') {
  narrowMq = viewportWindow.matchMedia(`(max-width: ${NARROW_MAX_WIDTH}px)`);
  syncNarrow(narrowMq);
  narrowMq.addEventListener('change', syncNarrow as EventListener);
}

onUnmounted(() => {
  off_look();
  narrowMq?.removeEventListener('change', syncNarrow as EventListener);
});
</script>

<style lang="scss" scoped>
.dbg-overlay {
  --dbg-panel: rgb(var(--panel-tint, 22 24 33) / var(--panel-alpha, 0.92));
  --dbg-border: rgb(255 255 255 / 0.1);
  --dbg-text: #f0f0f5;
  --dbg-text-secondary: #a0a0b0;
  --dbg-accent: #89b4fa;

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
  color: var(--dbg-text);
  font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  overflow: auto;
}

.dbg-main {
  width: 100%;
  max-width: 980px;
  min-width: 0;
  margin: auto;
  position: relative;
  height: min(820px, 100%);
  min-height: 420px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dbg-border);
  border-radius: 16px;
  background: var(--dbg-panel);
  backdrop-filter: blur(var(--panel-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-blur, 10px));
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.6);
  overflow: hidden;
}

.dbg-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--dbg-border);
}

.dbg-title {
  font-size: 1.25em;
  font-weight: 700;
  letter-spacing: 1px;
}

.dbg-sub {
  color: var(--dbg-text-secondary);
  font-size: 0.82em;
}

.dbg-spacer {
  flex: 1;
}

.dbg-btn {
  padding: 5px 12px;
  border: 1px solid var(--dbg-border);
  border-radius: 9px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  font-size: 0.86em;
  cursor: pointer;
}

.dbg-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.15);
}

.dbg-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.dbg-btn.small {
  margin-top: 8px;
  font-size: 0.8em;
}

.dbg-btn.primary {
  border-color: rgb(137 180 250 / 0.55);
  background: rgb(137 180 250 / 0.22);
}

.dbg-close {
  padding: 5px 12px;
  border: 1px solid var(--dbg-border);
  border-radius: 9px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  font-size: 0.86em;
  cursor: pointer;
}

.dbg-close:hover {
  background: rgb(243 139 168 / 0.25);
}

.dbg-body {
  flex: 1;
  padding: 16px 18px 22px;
  overflow-y: auto;
}

.dbg-tip {
  margin: 0 0 14px;
  color: var(--dbg-text-secondary);
  font-size: 0.82em;
  line-height: 1.6;
}

.dbg-sec {
  margin-bottom: 18px;
  padding: 12px 14px;
  border: 1px solid var(--dbg-border);
  border-radius: 12px;
  background: rgb(255 255 255 / 0.035);
}

.dbg-sec-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.dbg-sec-title {
  font-size: 0.98em;
  font-weight: 700;
}

.dbg-sec-note {
  color: var(--dbg-text-secondary);
  font-size: 0.76em;
}

.dbg-sub-title {
  margin: 10px 0 5px;
  color: var(--dbg-text-secondary);
  font-size: 0.78em;
  letter-spacing: 0.5px;
}

.dbg-hint {
  margin-left: 6px;
  opacity: 0.75;
}

.dbg-tag {
  padding: 1px 9px;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.08);
  color: var(--dbg-text-secondary);
  font-size: 0.76em;
}

.dbg-tag.ok {
  background: rgb(120 200 150 / 0.2);
  color: #a6e3b8;
}

.dbg-tag.warn {
  background: rgb(240 180 100 / 0.2);
  color: #f0c88a;
}

.dbg-kv {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dbg-kv span {
  padding: 3px 9px;
  border-radius: 8px;
  background: rgb(0 0 0 / 0.26);
  font-size: 0.78em;
}

.dbg-kv b {
  margin-right: 5px;
  color: var(--dbg-text-secondary);
  font-weight: 400;
}

.dbg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgb(0 0 0 / 0.18);
  font-size: 0.8em;
}

.dbg-row + .dbg-row {
  margin-top: 3px;
}

.dbg-row.leaf {
  background: transparent;
}

.dbg-name {
  flex: 1;
  min-width: 6em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, 'Cascadia Mono', monospace;
}

.dbg-bar {
  flex: none;
  width: 120px;
  height: 6px;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.08);
  overflow: hidden;
}

.dbg-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, rgb(137 180 250 / 0.85), rgb(203 166 247 / 0.85));
}

.dbg-size {
  flex: none;
  min-width: 5.5em;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.dbg-meta {
  flex: none;
  color: var(--dbg-text-secondary);
  font-size: 0.94em;
}

.dbg-empty,
.dbg-warn {
  margin: 0;
  color: var(--dbg-text-secondary);
  font-size: 0.8em;
}

.dbg-warn {
  color: #f0c88a;
}

.dbg-pre {
  max-height: 320px;
  margin: 8px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgb(0 0 0 / 0.3);
  font-family: ui-monospace, 'Cascadia Mono', monospace;
  font-size: 0.76em;
  line-height: 1.5;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.dbg-note {
  display: flex;
  gap: 8px;
  padding: 5px 9px;
  border-radius: 8px;
  background: rgb(0 0 0 / 0.18);
  font-size: 0.8em;
  line-height: 1.5;
}

.dbg-note + .dbg-note {
  margin-top: 3px;
}

.dbg-note.warning {
  background: rgb(240 180 100 / 0.14);
}

.dbg-note.error {
  background: rgb(240 130 130 / 0.16);
}

.dbg-note.success {
  background: rgb(120 200 150 / 0.14);
}

.dbg-note-time {
  flex: none;
  color: var(--dbg-text-secondary);
  font-variant-numeric: tabular-nums;
}

.dbg-note-title {
  flex: none;
  font-weight: 600;
}

.dbg-note-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

/* ---- 窄屏/手机: 面板铺满视口, 标题行才放得下 ---- */
.dbg-overlay.is-narrow {
  padding: 0;

  .dbg-main {
    margin: 0;
    max-width: none;
    min-height: 0;
    height: 100%;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .dbg-header {
    flex-wrap: wrap;
  }

  .dbg-bar {
    display: none;
  }
}

.dbg-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 7px 11px;
  border-radius: 9px;
  background: rgb(240 130 130 / 0.16);
  font-size: 0.82em;
}
</style>
