<!-- 卡牌详情弹窗: 基础资料 / 数值对比 / 效果 / 状态 / 位置 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <BattleModal :title="card.name" :subtitle="subtitle" layer="top" @close="emit('close')">
    <div class="cd-stats">
      <button
        v-for="row in stats"
        :key="row.stat"
        type="button"
        class="cd-stat"
        :class="[`cd-${row.label}`, { clickable: isClickable(row.stat) }]"
        :title="isClickable(row.stat) ? '点一下: 滚到这一项的来源并高亮' : ''"
        @click="focusStat(row.stat)"
      >
        <i>{{ row.label }}</i>
        <b>{{ row.value }}</b>
        <em v-if="row.delta">{{ row.delta > 0 ? '+' : '' }}{{ row.delta }}</em>
      </button>
    </div>

    <p v-if="description" class="cd-desc">{{ description }}</p>
    <p v-else class="cd-desc empty">(卡牌库里没有这张卡的描述)</p>

    <!-- 加成来源 / 池值变动紧跟数值行: 它就是「上面那些数字是怎么来的」 -->
    <template v-if="traceBlocks.length">
      <h4 class="cd-title">加成来源</h4>
      <div class="cd-traces">
        <div
          v-for="block in traceBlocks"
          :key="block.key"
          :ref="el => setBlockRef(block.stat, el)"
          class="cd-trace"
        >
          <div class="cd-trace-head">
            <span>{{ block.label }}</span>
            <b>{{ block.value }}</b>
            <em v-if="block.delta">(基础 {{ block.base }})</em>
          </div>
          <div v-for="(line, index) in block.shown" :key="index" class="cd-trace-line">{{ line }}</div>
          <button v-if="block.hidden" class="cd-more" type="button" @click="toggleExpand(block.key)">
            还有 {{ block.hidden }} 条 ▾
          </button>
          <button v-else-if="expanded[block.key]" class="cd-more" type="button" @click="toggleExpand(block.key)">
            收起 ▴
          </button>
        </div>
      </div>
    </template>

    <template v-if="poolBlocks.length">
      <h4 class="cd-title">池值变动</h4>
      <div class="cd-traces">
        <div
          v-for="block in poolBlocks"
          :key="block.key"
          :ref="el => setBlockRef(block.stat, el)"
          class="cd-trace cd-pool"
        >
          <div class="cd-trace-head">
            <span>{{ block.label }}</span>
            <b>{{ block.value }} / {{ block.max }}</b>
            <em v-if="block.net">(上场后 {{ block.net > 0 ? '+' : '' }}{{ block.net }})</em>
          </div>
          <div v-for="(line, index) in block.shown" :key="index" class="cd-trace-line">{{ line }}</div>
          <button v-if="block.hidden" class="cd-more" type="button" @click="toggleExpand(block.key)">
            还有 {{ block.hidden }} 条 ▾
          </button>
          <button v-else-if="expanded[block.key]" class="cd-more" type="button" @click="toggleExpand(block.key)">
            收起 ▴
          </button>
        </div>
      </div>
    </template>

    <h4 class="cd-title">资料</h4>
    <div class="cd-grid">
      <div v-for="row in info" :key="row.label" class="cd-row">
        <span>{{ row.label }}</span>
        <b>{{ row.value }}</b>
      </div>
    </div>

    <h4 class="cd-title">位置</h4>
    <div class="cd-grid">
      <div v-for="row in position" :key="row.label" class="cd-row">
        <span>{{ row.label }}</span>
        <b>{{ row.value }}</b>
      </div>
    </div>

    <template v-if="statuses.length">
      <h4 class="cd-title">状态</h4>
      <div class="cd-statuses">
        <span v-for="status in statusBlock.shown" :key="status.label" class="cd-status">
          {{ status.label }}
          <em v-if="status.stacks > 1">×{{ status.stacks }}</em>
          <em v-if="status.remaining !== null">{{ status.remaining }}T</em>
          <em v-if="status.source" class="from">←「{{ status.source }}」</em>
        </span>
      </div>
      <button v-if="statusBlock.hidden" class="cd-more" type="button" @click="toggleExpand(statusBlock.key)">
        还有 {{ statusBlock.hidden }} 个状态 ▾
      </button>
      <button v-else-if="expanded[statusBlock.key]" class="cd-more" type="button" @click="toggleExpand(statusBlock.key)">
        收起 ▴
      </button>
    </template>

    <template v-if="effects.length">
      <h4 class="cd-title">效果 (机读)</h4>
      <details v-for="effect in effects" :key="effect.label" class="cd-effect">
        <summary>
          <span class="cd-timing">{{ effect.timing }}</span>
          {{ effect.label }}
          <em v-if="effect.limit" class="cd-effect-limit">{{ effect.limit }}</em>
        </summary>
        <pre>{{ effect.detail }}</pre>
      </details>
    </template>

    <template v-if="practice || canReturn">
      <h4 class="cd-title">演习操作</h4>
      <div class="cd-actions">
        <button v-if="canPlay" class="cd-btn primary" type="button" @click="emit('play')">
          上场 (放到场上空位)
        </button>
        <button v-if="canReturn" class="cd-btn" type="button" @click="emit('return')">
          下场 (收回牌库)
        </button>
        <span v-if="practice && !canPlay && !canReturn" class="cd-note">这张卡现在没法操作。</span>
      </div>
    </template>
  </BattleModal>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';

import type { BattleState, CardInstance, StatKey } from '../../引擎/types.ts';
import {
  cardEffectRows,
  cardInfoRows,
  cardPoolRows,
  cardPositionRows,
  cardStatRows,
  cardStatusRows,
  cardTraceRows,
  ZONE_LABELS,
} from '../详情.ts';
import BattleModal from './BattleModal.vue';

const props = withDefaults(
  defineProps<{
    card: CardInstance;
    state: BattleState;
    /** 卡牌库里的自然语言描述 */
    description?: string;
    /** 是否演习模式 (可自由上场 / 下场) */
    practice?: boolean;
    /** 该方场上是否已满 */
    fieldFull?: boolean;
  }>(),
  { description: '', practice: false, fieldFull: false },
);

const emit = defineEmits<{ close: []; play: []; return: [] }>();

const subtitle = computed(() => {
  const parts = [props.card.rarity, props.card.type, ZONE_LABELS[props.card.zone]];
  return parts.filter(Boolean).join(' · ');
});

const stats = computed(() => cardStatRows(props.card));
const info = computed(() => cardInfoRows(props.card));
const position = computed(() => cardPositionRows(props.card));
const effects = computed(() => cardEffectRows(props.state, props.card));
const statuses = computed(() => cardStatusRows(props.state, props.card));
// 加成来源 / 池值变动都只对「场上的卡」有意义 —— 手里 / 墓地里的卡不会被别人的常驻效果改数值,
// 池值流水也在离场时清空了
const traces = computed(() => (props.card.zone === 'FIELD' ? cardTraceRows(props.state, props.card) : []));
const pools = computed(() => (props.card.zone === 'FIELD' ? cardPoolRows(props.state, props.card) : []));

// ---------------------------------------------------------------------------
// 「太长了就折起来」
//
// 详情弹窗本来就长 (数值 / 描述 / 资料 / 位置 / 状态 / 效果), 这几个列表又都可能一下子冒出
// 十几条 (超越体叠 10 条加成、一局里挨十几下……). 默认只摆前几条, 想看全的再展开。
// ---------------------------------------------------------------------------

/** 每个「加成来源」块默认显示几条 */
const TRACE_LINES = 5;
/** 每个「池值变动」块默认显示几条 (最新几条通常就是想知道的那几条) */
const POOL_LINES = 4;
/** 「状态」默认显示几个 */
const STATUS_LIMIT = 8;

const expanded = reactive<Record<string, boolean>>({});

function toggleExpand(key: string) {
  expanded[key] = !expanded[key];
}

/** 按展开状态截断一个列表 */
function clipped<T>(key: string, items: T[], limit: number): T[] {
  return expanded[key] ? items : items.slice(0, limit);
}

/** 还有几条被折起来了 (展开时为 0) */
function hiddenCount(key: string, total: number, limit: number): number {
  return expanded[key] ? 0 : Math.max(0, total - limit);
}

const traceBlocks = computed(() =>
  traces.value.map(row => {
    const key = `trace:${row.stat}`;
    return { ...row, key, shown: clipped(key, row.lines, TRACE_LINES), hidden: hiddenCount(key, row.lines.length, TRACE_LINES) };
  }),
);

const poolBlocks = computed(() =>
  pools.value.map(row => {
    const key = `pool:${row.stat}`;
    return { ...row, key, shown: clipped(key, row.lines, POOL_LINES), hidden: hiddenCount(key, row.lines.length, POOL_LINES) };
  }),
);

const statusBlock = computed(() => ({
  key: 'status',
  shown: clipped('status', statuses.value, STATUS_LIMIT),
  hidden: hiddenCount('status', statuses.value.length, STATUS_LIMIT),
}));

// ---------------------------------------------------------------------------
// 点数值 → 滚到对应的来源块并闪一下
// ---------------------------------------------------------------------------

const blockRefs: Record<string, HTMLElement | undefined> = {};

function setBlockRef(stat: StatKey, el: unknown) {
  blockRefs[stat] = (el as HTMLElement | null) ?? undefined;
}

/** 这个数值有对应的来源块可看 (没有就别让玩家白点一下) */
function isClickable(stat: StatKey): boolean {
  return traces.value.some(row => row.stat === stat) || pools.value.some(row => row.stat === stat);
}

/** 闪一下的起止颜色: 来源块是青的, 池值块是黄的 */
const FLASH: Record<string, [string, string]> = {
  trace: ['rgb(148 226 213 / 0.45)', 'rgb(148 226 213 / 0.07)'],
  pool: ['rgb(249 226 175 / 0.42)', 'rgb(249 226 175 / 0.07)'],
};

function focusStat(stat: StatKey) {
  const el = blockRefs[stat];
  if (!el) {
    return;
  }
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  // 用 Web Animations 而不是 class: 连点同一个数值也能重新播一遍
  const tint = stat === 'shield' || stat === 'hp' ? FLASH.pool : FLASH.trace;
  const flash = el.animate([{ backgroundColor: tint[0] }, { backgroundColor: tint[1] }], {
    duration: 900,
    easing: 'ease-out',
  });
  if (reduced) {
    flash.finish();
  }
}

const canPlay = computed(
  () => props.practice && (props.card.zone === 'DECK' || props.card.zone === 'HAND') && !props.fieldFull,
);
const canReturn = computed(() => props.practice && props.card.zone === 'FIELD');
</script>

<style scoped>
.cd-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.cd-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 4px;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.1));
  border-radius: 9px;
  background: rgb(255 255 255 / 0.05);
  /* 是个 <button>: 把所有默认样式清掉, 只留上面这身皮 */
  appearance: none;
  font: inherit;
  color: inherit;
  text-align: center;
}

.cd-stat.clickable {
  cursor: pointer;
}

.cd-stat.clickable:hover {
  border-color: rgb(148 226 213 / 0.45);
  background: rgb(148 226 213 / 0.1);
}

.cd-stat.clickable:active {
  transform: translateY(1px);
}

.cd-stat i {
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.76em;
  font-style: normal;
}

.cd-stat b {
  font-size: 1.15em;
}

.cd-stat em {
  font-size: 0.74em;
  font-style: normal;
  color: #a6e3a1;
}

.cd-攻击 b {
  color: #f38ba8;
}

.cd-护盾 b,
.cd-护盾上限 b {
  color: #89b4fa;
}

.cd-生命 b {
  color: #a6e3a1;
}

.cd-desc {
  margin: 0 0 12px;
  padding: 9px 11px;
  border-left: 3px solid rgb(137 180 250 / 0.5);
  border-radius: 0 8px 8px 0;
  background: rgb(255 255 255 / 0.04);
  font-size: 0.9em;
  line-height: 1.6;
  white-space: pre-wrap;
}

.cd-desc.empty {
  color: var(--bt-text-secondary, #a0a0b0);
}

.cd-title {
  margin: 14px 0 7px;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.8em;
  font-weight: 600;
  letter-spacing: 1px;
}

.cd-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 5px 12px;
}

.cd-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 0.88em;
}

.cd-row span {
  flex: none;
  width: 4.6em;
  color: var(--bt-text-secondary, #a0a0b0);
}

.cd-row b {
  font-weight: 500;
  word-break: break-all;
}

.cd-statuses {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cd-status {
  padding: 2px 8px;
  border: 1px solid rgb(250 179 135 / 0.35);
  border-radius: 999px;
  background: rgb(250 179 135 / 0.14);
  color: #fab387;
  font-size: 0.82em;
}

.cd-status em {
  margin-left: 4px;
  font-style: normal;
  opacity: 0.8;
}

/* 状态施加者 (溯回是哪张卡给的) */
.cd-status em.from {
  opacity: 0.65;
}

/* 加成来源: 每个数值一块, 每段来源一行 */
.cd-traces {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.cd-trace {
  padding: 7px 9px;
  border: 1px solid rgb(148 226 213 / 0.22);
  border-radius: 9px;
  background: rgb(148 226 213 / 0.07);
}

.cd-trace-head {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 0.86em;
}

.cd-trace-head span {
  color: var(--bt-text-secondary, #a0a0b0);
}

.cd-trace-head b {
  color: #94e2d5;
  font-size: 1.06em;
}

.cd-trace-head em {
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.92em;
  font-style: normal;
}

.cd-trace-line {
  margin-top: 3px;
  padding-left: 10px;
  border-left: 2px solid rgb(148 226 213 / 0.35);
  color: #d6f2ee;
  font-size: 0.84em;
  word-break: break-word;
}

/* 池值块 (护盾 / 生命): 与「加成来源」区分开 —— 那是分层修正, 这是流水 */
.cd-pool {
  border-color: rgb(249 226 175 / 0.22);
  background: rgb(249 226 175 / 0.07);
}

.cd-pool .cd-trace-head b {
  color: #f9e2af;
}

.cd-pool .cd-trace-line {
  border-left-color: rgb(249 226 175 / 0.35);
  color: #f4e6c4;
}

/* 「还有 N 条」/「收起」: 详情本来就长, 默认只摆前几条 */
.cd-more {
  margin-top: 5px;
  padding: 1px 9px;
  border: 1px dashed var(--bt-border, rgb(255 255 255 / 0.18));
  border-radius: 999px;
  background: transparent;
  color: var(--bt-text-secondary, #a0a0b0);
  font: inherit;
  font-size: 0.8em;
  cursor: pointer;
}

.cd-more:hover {
  border-color: rgb(148 226 213 / 0.5);
  color: #94e2d5;
}

.cd-effect {
  margin-bottom: 6px;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.1));
  border-radius: 9px;
  background: rgb(255 255 255 / 0.03);
  font-size: 0.88em;
}

.cd-effect summary {
  padding: 7px 10px;
  cursor: pointer;
}

.cd-timing {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgb(137 180 250 / 0.2);
  color: var(--bt-accent, #89b4fa);
  font-size: 0.86em;
}

/* 使用次数用量 (如「本回合 2/2 次」): 技能不发动时用它圆话 */
.cd-effect-limit {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgb(249 226 175 / 0.16);
  color: #f9e2af;
  font-size: 0.82em;
  font-style: normal;
}

.cd-effect pre {
  margin: 0;
  padding: 0 10px 10px;
  overflow-x: auto;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.88em;
  line-height: 1.5;
}

.cd-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.cd-note {
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.84em;
}

.cd-btn {
  padding: 5px 12px;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.12));
  border-radius: 8px;
  background: rgb(255 255 255 / 0.07);
  color: inherit;
  font-family: inherit;
  font-size: 0.86em;
  cursor: pointer;
}

.cd-btn:hover {
  background: rgb(255 255 255 / 0.15);
}

.cd-btn.primary {
  border-color: rgb(137 180 250 / 0.5);
  background: rgb(137 180 250 / 0.24);
}
</style>
