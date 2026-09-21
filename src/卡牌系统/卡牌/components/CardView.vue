<!-- 卡牌预览渲染: 视觉风格参考 "regex-战斗卡牌-半透明UR流光" 的毛玻璃半透明卡 + 稀有度流光角标 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <article v-if="card" class="cv card" :class="`rarity-bg-${card.rarity}`">
    <div v-if="card.rarity" class="rarity-badge" :class="`rarity-${card.rarity}`">{{ card.rarity }}</div>
    <div v-if="card.阵营 && card.阵营 !== '通用'" class="faction-badge" :class="`faction-${card.阵营}`">
      {{ card.阵营 }}
    </div>

    <div class="card-name">{{ displayName }}</div>
    <div v-if="starText" class="card-stars">{{ starText }}</div>
    <div v-if="card.type" class="card-type">{{ card.type }}{{ card.series ? ` · ${card.series}` : '' }}</div>

    <div v-if="propsRows.length" class="card-props">
      <div v-for="row in propsRows" :key="row.label">{{ row.label }}: {{ row.value }}</div>
    </div>

    <div v-if="statsRows.length" class="card-stats-line">
      <div v-for="row in statsRows" :key="row.label" :class="row.cls">
        {{ row.label }}: <span>{{ row.base }}</span><small v-if="row.extra">[{{ row.extra }}]</small>
      </div>
    </div>

    <div v-if="card.description" class="card-effect">
      <div class="card-effect-title">效果</div>
      <p>{{ card.description }}</p>
    </div>

    <details v-if="machineYaml" class="machine-effect">
      <summary>机读效果</summary>
      <pre>{{ machineYaml }}</pre>
    </details>
  </article>

  <article v-else class="cv card placeholder-card">
    <div class="placeholder-title">卡牌预览</div>
    <div class="placeholder-hint">从左侧选择一张卡牌, 或点击「新建卡牌」开始创建</div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { machineEffectToYaml } from '../data';
import type { Card } from '../schema';

const props = defineProps<{ card: Card | undefined | null }>();

const displayName = computed(() => props.card?.name?.trim() || '【未命名卡牌】');

/** 星级 (0 = 未设置) 渲染成 ★ 串 */
const starText = computed(() => {
  const stars = props.card?.stars ?? 0;
  return stars > 0 ? '★'.repeat(stars) : '';
});

/** 将 "300[+100]" 这类字段拆成主值 + 角标说明 */
function splitBracketed(value: string): { base: string; extra: string } {
  const match = value.trim().match(/^([^[]+)(?:\[(.*)\])?$/);
  if (!match) {
    return { base: value, extra: '' };
  }
  return { base: match[1]?.trim() ?? '', extra: match[2]?.trim() ?? '' };
}

const propsRows = computed(() => {
  const card = props.card;
  if (!card) return [];
  const rows: { label: string; value: string }[] = [];
  if (card.attribute) rows.push({ label: '属性', value: card.attribute });
  if (card.gender) rows.push({ label: '性别', value: card.gender });
  if (card.race) rows.push({ label: '种族', value: card.race });
  if (card.height) rows.push({ label: '身高', value: card.height });
  return rows;
});

const statsRows = computed(() => {
  const card = props.card;
  if (!card) return [];
  const defs = [
    { label: '能量', value: card.energy, cls: 'stat-energy' },
    { label: 'ATK', value: card.atk, cls: 'stat-atk' },
    { label: '护盾', value: card.shield, cls: 'stat-shield' },
    { label: 'HP', value: card.hp, cls: 'stat-hp' },
  ];
  return defs
    .filter(row => row.value)
    .map(row => {
      const { base, extra } = splitBracketed(row.value ?? '');
      return { label: row.label, base, extra, cls: row.cls };
    });
});

const machineYaml = computed(() => (props.card ? machineEffectToYaml(props.card.machine_effect) : ''));
</script>

<style lang="scss" scoped>
@use '../../共用/稀有度' as *;

.cv {
  // 卡面视觉变量 (仅作用于本组件子树, 不污染酒馆)
  --text-primary: #f0f0f5;
  --text-secondary: #a0a0b0;
  --accent-color: #89b4fa;
  --hp-color: #a6e3a1;
  --atk-color: #f38ba8;
  --shield-color: #89b4fa;
  --energy-color: #f9e2af;
  --panel-blur: 3px;

  position: relative;
  isolation: isolate;
  width: 100%;
  max-width: 350px;
  margin: 0 auto;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-sizing: border-box;
  padding: 24px 12px 12px;
  border: 1px solid rgb(255 255 255 / 0.2);
  border-radius: 12px;
  background: rgb(28 30 39 / 0.52);
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.28);
  backdrop-filter: blur(var(--panel-blur));
  -webkit-backdrop-filter: blur(var(--panel-blur));
}

.cv > * {
  position: relative;
  z-index: 1;
}

.card-name {
  font-weight: 700;
  font-size: 1.3em;
  margin-bottom: 4px;
  padding-right: 48px;
}

.card-stars {
  color: #ffd700;
  font-size: 1.2em;
  letter-spacing: 1px;
}

.card-type {
  font-style: italic;
  color: var(--text-secondary);
}

.card-props,
.card-stats-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.card-props > div,
.card-stats-line > div {
  background: rgb(0 0 0 / 0.25);
  padding: 2px 6px;
  border-radius: 4px;
}

.stat-hp {
  color: var(--hp-color);
}

.stat-atk {
  color: var(--atk-color);
}

.stat-shield {
  color: var(--shield-color);
}

.stat-energy {
  color: var(--energy-color);
}

.card-stats-line small {
  color: var(--text-secondary);
  font-size: 0.8em;
}

.rarity-badge {
  position: absolute;
  z-index: 2;
  top: 8px;
  right: 8px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 6px;
  color: #07111f;
}

.faction-badge {
  position: absolute;
  z-index: 2;
  top: 8px;
  left: 8px;
  font-size: 0.78em;
  padding: 1px 7px;
  border-radius: 6px;
  border: 1px solid currentcolor;
  background: rgb(0 0 0 / 0.35);
}

.faction-我方 {
  color: #89b4fa;
}

.faction-敌方 {
  color: #f38ba8;
}

.rarity-N {
  background: #b0bec5;
}

.rarity-R {
  background: #81d4fa;
}

.rarity-SR {
  background: linear-gradient(45deg, #ce93d8, #ab47bc);
  color: #fff;
}

.rarity-SSR {
  background: linear-gradient(45deg, #ffd700, #ffb74d);
  color: #442b00;
}

/* UR 角标: 半透明本体 + 身后一圈转着的彩虹条纹, 见 共用/稀有度.scss */
.rarity-UR {
  @include rare-shimmer;
}

.card.rarity-bg-SR {
  background:
    radial-gradient(circle at top right, rgb(171 71 188 / 0.18), transparent 70%),
    rgb(48 34 58 / 0.5);
}

.card.rarity-bg-SSR {
  background: rgb(62 53 35 / 0.5);
  border-color: rgb(255 215 0 / 0.45);
}

.card.rarity-bg-UR {
  background: rgb(28 38 56 / 0.48);
  border-color: rgb(139 233 253 / 0.48);
}

.card-effect {
  margin-top: 6px;
}

.card-effect-title {
  color: var(--accent-color);
  font-weight: 700;
  margin-bottom: 4px;
}

.card-effect p {
  margin: 0;
  padding: 8px;
  background: rgb(0 0 0 / 0.2);
  border-radius: 6px;
  white-space: pre-wrap;
  line-height: 1.5;
}

.machine-effect {
  margin-top: 4px;
}

.machine-effect summary {
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 0.8em;
  user-select: none;
}

.machine-effect pre {
  margin: 4px 0 0;
  padding: 8px;
  background: rgb(0 0 0 / 0.3);
  border-radius: 6px;
  font-size: 0.78em;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  max-height: 160px;
  overflow-y: auto;
}

.placeholder-card {
  align-items: center;
  justify-content: center;
  min-height: 320px;
  gap: 10px;
  text-align: center;
}

.placeholder-title {
  font-size: 1.2em;
  font-weight: 700;
  color: var(--text-secondary);
}

.placeholder-hint {
  font-size: 0.85em;
  color: var(--text-secondary);
  opacity: 0.75;
}
</style>
