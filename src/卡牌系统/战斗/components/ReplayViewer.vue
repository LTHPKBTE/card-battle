<!-- 战斗回溯弹窗: 列出每一步操作, 可把战斗退回到任意一步之前 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <BattleModal title="战斗回溯" :subtitle="subtitle" wide @close="emit('close')">
    <p class="rp-tips">
      战斗是按「起点 + 每一步操作」重演出来的, 所以回到任何一步之前得到的局面都和当初完全一致;
      退回去之后, 后面的分支会直接丢弃, 不会留下痕迹。
    </p>

    <div class="rp-bar">
      <button
        class="rp-btn danger"
        type="button"
        :disabled="!canRewind || steps.length === 0"
        @click="askRewind(0)"
      >
        {{ pending === 0 ? '再点一次, 确认回到最开始' : '回到最开始' }}
      </button>
      <span class="rp-size">{{ sizeText }}</span>
    </div>

    <div v-if="!canRewind" class="rp-note">现在没有进行中的正式战斗, 只能查看步骤, 不能回退。</div>
    <div v-else-if="report && !report.一致" class="rp-note warn">
      回放校验不一致: {{ report.错误 || report.差异 }}。回退仍然可用, 但退出来的局面可能与当初不同 (通常是卡牌库被改过)。
    </div>

    <div v-if="steps.length === 0" class="rp-empty">还没有记录到任何操作。</div>
    <div v-else class="rp-list">
      <div v-for="(step, index) in rows" :key="step.序号" class="rp-item" :class="{ latest: index === 0 }">
        <span class="rp-seq">#{{ step.序号 }}</span>
        <span class="rp-turn">T{{ step.回合 }}</span>
        <span class="rp-side" :class="step.方 === 'PLAYER' ? 'me' : 'foe'">{{ SIDE_LABELS[step.方] }}</span>
        <span class="rp-src">
          {{ step.来源 === 'AI' ? `AI 决策${step.楼层 === null ? '' : ` #${step.楼层}`}` : '玩家操作' }}
        </span>
        <span class="rp-text">{{ step.说明 || '(无操作)' }}</span>
        <button
          class="rp-btn"
          type="button"
          :disabled="!canRewind"
          :title="`退掉这一步与之后共 ${steps.length - step.keep} 步`"
          @click="askRewind(step.keep)"
        >
          {{ pending === step.keep ? '确认回退' : '回到此前' }}
        </button>
      </div>
    </div>

    <p class="rp-foot">
      提示: 在酒馆里对 AI 的决策楼层点「重新生成」时, 战斗会自动退回到那一层之前并重新结算,
      不需要在这里手动回退。
    </p>
  </BattleModal>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';

import type { ReplayReport, ReplaySize } from '../回放.ts';
import type { ReplayStep } from '../schema.ts';
import BattleModal from './BattleModal.vue';

const props = defineProps<{
  steps: ReplayStep[];
  report: ReplayReport | null;
  /** 起点之前已合并掉的步数 (只影响展示) */
  dropped: number;
  /** 现在是否还能回退 (正式战斗中才有意义) */
  canRewind: boolean;
}>();

const emit = defineEmits<{ close: []; rewind: [keep: number] }>();

const SIDE_LABELS: Record<'PLAYER' | 'ENEMY', string> = { PLAYER: '我方', ENEMY: '敌方' };

/** 危险操作要点两次, 这里记住「上一次点的是哪一行」(keep 值) */
const pending = ref<number | null>(null);
let timer: number | null = null;

/** 最新的排在最前面 (最常用的就是「撤销刚发生的那一步」) */
const rows = computed(() =>
  props.steps
    .map((step, index) => ({ ...step, keep: index }))
    .reverse(),
);

const size = computed<ReplaySize | null>(() => props.report?.体积 ?? null);
const sizeText = computed(() => {
  if (!size.value) {
    return props.steps.length === 0 ? '暂无回放数据' : `${props.steps.length} 步`;
  }
  const merged = props.dropped > 0 ? `, 已合并 ${props.dropped} 步进起点` : '';
  return `${props.steps.length} 步${merged} · 回放数据约 ${size.value.合计} 字符 (步骤 ${size.value.步骤} / 起点 ${size.value.起点}, 单步均 ${size.value.平均每步})`;
});

const subtitle = computed(() => {
  if (props.report?.有起点) {
    return '从起点快照重演';
  }
  return props.steps.length > 0 ? '从开局重演' : '';
});

/** 回退是不可逆的, 所以要点两次 (第一次只是把按钮变成确认) */
function askRewind(keep: number) {
  if (!props.canRewind) {
    return;
  }
  if (pending.value === keep) {
    clearTimer();
    pending.value = null;
    emit('rewind', keep);
    return;
  }
  pending.value = keep;
  clearTimer();
  timer = window.setTimeout(() => {
    pending.value = null;
    timer = null;
  }, 5000);
}

function clearTimer() {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

onUnmounted(clearTimer);
</script>

<style scoped>
.rp-tips,
.rp-foot {
  margin: 0 0 10px;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.82em;
  line-height: 1.5;
}

.rp-foot {
  margin: 10px 0 0;
}

.rp-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.rp-size {
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.78em;
}

.rp-note {
  margin-bottom: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgb(255 255 255 / 0.06);
  font-size: 0.82em;
  line-height: 1.5;
}

.rp-note.warn {
  background: rgb(250 200 120 / 0.14);
  color: #ffd79a;
}

.rp-empty {
  padding: 14px;
  color: var(--bt-text-secondary, #a0a0b0);
  text-align: center;
  font-size: 0.85em;
}

.rp-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rp-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: rgb(255 255 255 / 0.04);
  font-size: 0.82em;
}

.rp-item.latest {
  border-color: rgb(137 180 250 / 0.42);
  background: rgb(137 180 250 / 0.13);
}

.rp-seq {
  flex: none;
  min-width: 2.6em;
  color: var(--bt-text-secondary, #a0a0b0);
  font-variant-numeric: tabular-nums;
}

.rp-turn {
  flex: none;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.rp-side {
  flex: none;
  padding: 0 6px;
  border-radius: 6px;
  font-size: 0.94em;
}

.rp-side.me {
  background: rgb(120 200 160 / 0.22);
  color: #a5e6c3;
}

.rp-side.foe {
  background: rgb(240 130 130 / 0.2);
  color: #ffb4b4;
}

.rp-src {
  flex: none;
  color: var(--bt-text-secondary, #a0a0b0);
}

.rp-text {
  flex: 1;
  min-width: 8em;
  word-break: break-word;
}

.rp-btn {
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.12));
  border-radius: 7px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  font-size: 0.95em;
  cursor: pointer;
}

.rp-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.16);
}

.rp-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.rp-btn.danger {
  border-color: rgb(240 130 130 / 0.4);
  color: #ffb4b4;
}

.rp-btn.danger:hover:not(:disabled) {
  background: rgb(240 130 130 / 0.18);
}
</style>
