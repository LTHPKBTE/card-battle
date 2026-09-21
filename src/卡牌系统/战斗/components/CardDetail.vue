<!-- 卡牌详情弹窗: 基础资料 / 数值对比 / 效果 / 状态 / 位置 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <BattleModal :title="card.name" :subtitle="subtitle" @close="emit('close')">
    <div class="cd-stats">
      <span v-for="row in stats" :key="row.label" class="cd-stat" :class="`cd-${row.label}`">
        <i>{{ row.label }}</i>
        <b>{{ row.value }}</b>
        <em v-if="row.delta">{{ row.delta > 0 ? '+' : '' }}{{ row.delta }}</em>
      </span>
    </div>

    <p v-if="description" class="cd-desc">{{ description }}</p>
    <p v-else class="cd-desc empty">(卡牌库里没有这张卡的描述)</p>

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

    <template v-if="traces.length">
      <h4 class="cd-title">加成来源</h4>
      <div class="cd-traces">
        <div v-for="row in traces" :key="row.label" class="cd-trace">
          <div class="cd-trace-head">
            <span>{{ row.label }}</span>
            <b>{{ row.value }}</b>
            <em v-if="row.delta">(基础 {{ row.base }})</em>
          </div>
          <div v-for="line in row.lines" :key="line" class="cd-trace-line">{{ line }}</div>
        </div>
      </div>
    </template>

    <template v-if="statuses.length">
      <h4 class="cd-title">状态</h4>
      <div class="cd-statuses">
        <span v-for="status in statuses" :key="status.label" class="cd-status">
          {{ status.label }}
          <em v-if="status.stacks > 1">×{{ status.stacks }}</em>
          <em v-if="status.remaining !== null">{{ status.remaining }}T</em>
          <em v-if="status.source" class="from">←「{{ status.source }}」</em>
        </span>
      </div>
    </template>

    <template v-if="effects.length">
      <h4 class="cd-title">效果 (机读)</h4>
      <details v-for="effect in effects" :key="effect.label" class="cd-effect">
        <summary>
          <span class="cd-timing">{{ effect.timing }}</span>
          {{ effect.label }}
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
import { computed } from 'vue';

import type { BattleState, CardInstance } from '../../引擎/types.ts';
import {
  cardEffectRows,
  cardInfoRows,
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
// 加成只对「场上的卡」有意义 —— 手里 / 墓地里的卡不会被别人的常驻效果改数值
const traces = computed(() => (props.card.zone === 'FIELD' ? cardTraceRows(props.state, props.card) : []));

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
