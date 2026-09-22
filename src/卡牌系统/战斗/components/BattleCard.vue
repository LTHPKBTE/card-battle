<!-- 战斗中的一张卡 (紧凑展示; 拖动/点击逻辑由外层负责) -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <div
    :key="`${card.id}#${fxSerial}`"
    class="bc"
    :class="[
      `rarity-${card.rarity}`,
      `bg-${card.rarity}`,
      card.controller === 'PLAYER' ? 'mine' : 'theirs',
      fxKind ? `fx-${fxKind}` : '',
      {
        'is-selected': selected,
        'is-targetable': targetable,
        'is-inactive': inactive,
        'is-dead': card.current.hp <= 0,
        'is-ready': ready,
      },
    ]"
  >
    <div class="bc-head">
      <span class="bc-rarity" :class="`rarity-${card.rarity}`">{{ card.rarity }}</span>
      <span class="bc-name" :title="card.name">{{ card.name }}</span>
      <span v-if="card.attacked_this_turn" class="bc-flag">已攻击</span>
    </div>

    <div class="bc-stats">
      <span class="bc-stat atk">
        <i>攻</i><b>{{ card.current.atk }}</b><em v-if="atkDelta()">{{ atkDelta() }}</em>
      </span>
      <span class="bc-stat shield">
        <i>盾</i><b>{{ card.current.shield }}/{{ card.current.shield_max }}</b><em v-if="shieldDelta()">{{ shieldDelta() }}</em>
      </span>
      <span class="bc-stat hp">
        <i>HP</i><b>{{ card.current.hp }}/{{ card.current.hp_max }}</b><em v-if="hpDelta()">{{ hpDelta() }}</em>
      </span>
    </div>

    <div v-if="card.current.shield_max > 0" class="bc-shieldbar">
      <i :style="{ width: shieldPercent() }" />
    </div>

    <div class="bc-hpbar">
      <i :style="{ width: hpPercent() }" />
    </div>

    <div v-if="statuses.length" class="bc-statuses">
      <span v-for="(status, index) in statuses" :key="index" class="bc-status">
        {{ status.name }}<template v-if="status.stacks > 1">×{{ status.stacks }}</template>
        <em v-if="status.remaining !== null">{{ status.remaining }}T</em>
      </span>
    </div>

    <div v-if="hint" class="bc-hint">{{ hint }}</div>

    <!-- 一次性浮字 (技能名 / 伤害数字): 由外层传入的动画标记驱动 -->
    <span v-if="fxText" class="bc-float">{{ fxText }}</span>
  </div>
</template>

<script setup lang="ts">
import type { CardInstance } from '../../引擎/types.ts';

/** 卡片上要显示的一条持续状态 */
export interface BattleCardStatus {
  name: string;
  stacks: number;
  remaining: number | null;
}

const props = withDefaults(
  defineProps<{
    card: CardInstance;
    statuses?: BattleCardStatus[];
    selected?: boolean;
    targetable?: boolean;
    inactive?: boolean;
    hint?: string;
    /** 此刻真的能主动发动 (亮一圈光边, 提醒「这张卡现在有事可做」) */
    ready?: boolean;
    /** 一次性动画标记: '' | draw | play | attack | hit | heal | skill | death */
    fxKind?: string;
    /** 动画流水号: 号一变就重建元素, 动画得以重播 */
    fxSerial?: number;
    /** 浮出来的文字 (技能名 / 伤害数字) */
    fxText?: string;
  }>(),
  {
    statuses: () => [],
    selected: false,
    targetable: false,
    inactive: false,
    hint: '',
    ready: false,
    fxKind: '',
    fxSerial: 0,
    fxText: '',
  },
);

/** 当前值与基础值的差异 (正数显示为 +N, 没有变化返回空串) */
function delta(current: number, base: number): string {
  const change = current - base;
  return change === 0 ? '' : `${change > 0 ? '+' : ''}${change}`;
}

/** 攻击力差异 */
function atkDelta(): string {
  return delta(props.card.current.atk, props.card.base.atk);
}

/** 护盾上限差异 (和基础护盾比, 可以看出有没有被加过上限) */
function shieldDelta(): string {
  return delta(props.card.current.shield_max, props.card.base.shield);
}

/** 生命上限差异 (和基础生命比, 可以看出有没有被加过上限) */
function hpDelta(): string {
  return delta(props.card.current.hp_max, props.card.base.hp);
}

/**
 * 护盾条宽度 (当前护盾 / 护盾上限).
 *
 * 与 hpPercent() 同理, 用普通函数避开 computed 缓存.
 */
function shieldPercent(): string {
  const max = props.card.current.shield_max || 1;
  return `${Math.max(0, Math.min(100, (props.card.current.shield / max) * 100))}%`;
}

/**
 * 血条宽度.
 *
 * 这里刻意用普通函数而不是 computed: 战斗状态是引擎里被原地改写的普通对象,
 * computed 的依赖 (props.card 这个引用) 自始至终不会变, 缓存因此永不失效 ——
 * 结果就是卡面上的数字刷新了, 血条却一直停在原来的宽度.
 */
function hpPercent(): string {
  const max = props.card.current.hp_max || 1;
  return `${Math.max(0, Math.min(100, (props.card.current.hp / max) * 100))}%`;
}
</script>

<style lang="scss" scoped>
@use '../../共用/稀有度' as *;

.bc {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px 8px;
  border: 1px solid rgb(255 255 255 / 0.16);
  border-radius: 8px;
  background: rgb(22 24 32 / 0.72);
  font-size: 12.5px;
  line-height: 1.35;
  cursor: pointer;
  user-select: none;
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.1s;
  /* 填满外层 .bt-card-wrap: 否则卡牌会缩成内容宽度, 比场上空位的占位框窄一截 */
  width: 100%;
  /* 但不要把格子撑破 (窄屏下格子可能比 118px 还窄) */
  min-width: min(118px, 100%);
}

.bc:hover {
  border-color: rgb(255 255 255 / 0.4);
}

.bc.is-selected {
  border-color: var(--accent-color, #8be9fd);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-color, #8be9fd) 45%, transparent);
}

.bc.is-targetable {
  border-color: #ff6b6b;
  box-shadow: 0 0 0 2px rgb(255 107 107 / 0.4);
  animation: target-pulse 1.1s ease-in-out infinite;
}

.bc.is-inactive {
  opacity: 0.55;
}

/* 可选的目标即使「轮不到我操作这一边」也不灰化, 否则对方卡灰蒙蒙的, 看不出可以打 */
.bc.is-inactive.is-targetable {
  opacity: 1;
}

.bc.is-dead {
  opacity: 0.35;
  filter: grayscale(0.8);
}

/* 现在真的能发动技能的卡: 一圈呼吸的金色光边 (与蓝色选中 / 红色可选目标区分开) */
.bc.is-ready {
  border-color: rgb(249 226 175 / 0.8);
  animation: bc-ready 1.8s ease-in-out infinite;
}

@keyframes bc-ready {
  0%,
  100% {
    box-shadow:
      0 0 0 1px rgb(249 226 175 / 0.25),
      0 0 10px rgb(249 226 175 / 0.28);
  }

  50% {
    box-shadow:
      0 0 0 1px rgb(249 226 175 / 0.5),
      0 0 18px rgb(249 226 175 / 0.5);
  }
}

@keyframes target-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 2px rgb(255 107 107 / 0.25);
  }
  50% {
    box-shadow: 0 0 0 4px rgb(255 107 107 / 0.5);
  }
}

.bc-head {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.bc-rarity {
  flex: none;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  background: rgb(255 255 255 / 0.18);
}

.bc-rarity.rarity-R {
  background: linear-gradient(45deg, #7ec8e3, #4a90a4);
  color: #04212b;
}

.bc-rarity.rarity-SR {
  background: linear-gradient(45deg, #ce93d8, #ab47bc);
  color: #fff;
}

.bc-rarity.rarity-SSR {
  background: linear-gradient(45deg, #ffd700, #ffb74d);
  color: #442b00;
}

.bc-rarity.rarity-UR {
  @include rare-shimmer;
}

.bc-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: 700;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.bc-flag {
  flex: none;
  padding: 0 4px;
  border-radius: 4px;
  background: rgb(255 255 255 / 0.14);
  color: var(--text-secondary, #9aa4b2);
  font-size: 10px;
}

.bc-stats {
  display: grid;
  /* 列数由外层面板决定: 窄屏会把它改成 1fr (见 App.vue 的窄屏样式) ——
     两列时「攻 500 +200 / 盾 100/200」在手机宽度下塞不下, 数字会越过卡框 */
  grid-template-columns: var(--bt-stat-columns, 1fr 1fr);
  gap: 3px 8px;
  font-variant-numeric: tabular-nums;
}

.bc-stat {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  white-space: nowrap;
}

/* HP 占满一整行, 数值最长 */
.bc-stat.hp {
  grid-column: 1 / -1;
}

.bc-stat i {
  flex: none;
  font-style: normal;
  font-size: 10px;
  opacity: 0.72;
}

.bc-stat b {
  font-weight: 700;
}

.bc-stat.atk b {
  color: #ffb86c;
}

.bc-stat.shield b {
  color: #8be9fd;
}

.bc-stat.hp b {
  color: #a6e22e;
}

.bc-stat em {
  flex: none;
  margin-left: 1px;
  font-size: 10px;
  font-style: normal;
  opacity: 0.85;
}

.bc-hpbar {
  height: 4px;
  border-radius: 2px;
  background: rgb(255 255 255 / 0.14);
  overflow: hidden;
}

.bc-shieldbar {
  height: 3px;
  border-radius: 2px;
  background: rgb(255 255 255 / 0.12);
  overflow: hidden;
}

.bc-shieldbar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #8be9fd, #4aa8d8);
  transition: width 0.2s;
}

.bc-hpbar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #a6e22e, #4caf50);
  transition: width 0.2s;
}

.bc-statuses {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.bc-status {
  padding: 0 4px;
  border-radius: 4px;
  background: rgb(189 147 249 / 0.22);
  color: #d7c4ff;
  font-size: 10px;
  white-space: nowrap;
}

.bc-status em {
  margin-left: 2px;
  font-style: normal;
  opacity: 0.7;
}

.bc-hint {
  color: var(--text-secondary, #9aa4b2);
  font-size: 10px;
}

.bg-SR {
  background: radial-gradient(circle at top right, rgb(171 71 188 / 0.22), transparent 70%), rgb(22 24 32 / 0.78);
}

.bg-SSR {
  background: rgb(48 42 28 / 0.8);
  border-color: rgb(255 215 0 / 0.35);
}

.bg-UR {
  background: rgb(22 30 44 / 0.8);
  border-color: rgb(139 233 253 / 0.4);
}

/* ---------------------------------------------------------------------------
   一次性动画

   外层面板每次刷新时对比「上一份快照」与「现在的状态」, 把差异翻成一个标记
   (draw / play / attack / hit / heal / skill / death) 与一个流水号传进来;
   流水号进 key, 所以同一个动画连着触发两次也能重播。
   注意这些规则要写在 .is-ready 之后 —— 同时命中时以一次性动画为准。
   --------------------------------------------------------------------------- */

/* 浮字: 技能名 / 伤害数字.
   先停 2 秒给人看清, 再用 0.6 秒淡掉 —— 时长与 App.vue 里的
   FX_TEXT_HOLD_MS / FX_TEXT_FADE_MS 对齐 (0.2 秒淡入 / 停到 2.0 秒 / 2.6 秒没). */
.bc-float {
  position: absolute;
  bottom: 100%;
  left: 50%;
  z-index: 6;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgb(8 9 13 / 0.7);
  color: #f9e2af;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  pointer-events: none;
  animation: bc-float 2.6s ease-out;
}

.bc.fx-hit .bc-float {
  color: #ff8a8a;
}

.bc.fx-heal .bc-float {
  color: #a6e22e;
}

.bc.fx-draw {
  animation: bc-fx-draw 0.6s ease-out;
}

.bc.fx-play {
  animation: bc-fx-play 0.6s cubic-bezier(0.2, 1.5, 0.4, 1);
}

/* 攻击者先往对面拱一下: 我方在下往上拱, 敌方在上往下拱 */
.bc.fx-attack.mine {
  animation: bc-fx-lunge-up 0.52s ease-out;
}

.bc.fx-attack.theirs {
  animation: bc-fx-lunge-down 0.52s ease-out;
}

.bc.fx-hit {
  animation: bc-fx-hit 0.6s ease-out;
}

.bc.fx-heal {
  animation: bc-fx-heal 0.7s ease-out;
}

.bc.fx-skill {
  animation: bc-fx-skill 0.9s ease-out;
}

.bc.fx-death {
  animation: bc-fx-death 0.76s ease-in forwards;
}

/* 与 FX_TEXT_HOLD_MS / FX_TEXT_FADE_MS 对齐: 停 2 秒, 再 0.6 秒淡掉 */
@keyframes bc-float {
  0% {
    opacity: 0;
    transform: translate(-50%, 6px);
  }

  8% {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  77% {
    opacity: 1;
    transform: translate(-50%, -6px);
  }

  100% {
    opacity: 0;
    transform: translate(-50%, -14px);
  }
}

@keyframes bc-fx-draw {
  from {
    opacity: 0;
    transform: translateY(-10px) scale(0.92);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes bc-fx-play {
  0% {
    transform: scale(0.8);
    box-shadow: 0 0 0 0 rgb(249 226 175 / 0.6);
  }

  60% {
    transform: scale(1.05);
    box-shadow: 0 0 0 7px rgb(249 226 175 / 0);
  }

  100% {
    transform: none;
    box-shadow: none;
  }
}

@keyframes bc-fx-lunge-up {
  0% {
    transform: none;
  }

  35% {
    transform: translateY(-9px) scale(1.03);
  }

  100% {
    transform: none;
  }
}

@keyframes bc-fx-lunge-down {
  0% {
    transform: none;
  }

  35% {
    transform: translateY(9px) scale(1.03);
  }

  100% {
    transform: none;
  }
}

@keyframes bc-fx-hit {
  0%,
  100% {
    transform: none;
    box-shadow: none;
  }

  12% {
    transform: translateX(-5px);
    box-shadow: 0 0 0 2px rgb(255 107 107 / 0.65);
  }

  30% {
    transform: translateX(4px);
    box-shadow: 0 0 0 2px rgb(255 107 107 / 0.45);
  }

  48% {
    transform: translateX(-3px);
  }

  66% {
    transform: translateX(2px);
  }
}

@keyframes bc-fx-heal {
  0% {
    box-shadow: 0 0 0 0 rgb(166 226 46 / 0.6);
  }

  70% {
    box-shadow: 0 0 0 8px rgb(166 226 46 / 0);
  }

  100% {
    box-shadow: none;
  }
}

@keyframes bc-fx-skill {
  0% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgb(249 226 175 / 0.75);
  }

  40% {
    transform: scale(1.04);
    box-shadow: 0 0 14px 3px rgb(249 226 175 / 0.5);
  }

  100% {
    transform: none;
    box-shadow: 0 0 0 12px rgb(249 226 175 / 0);
  }
}

@keyframes bc-fx-death {
  from {
    opacity: 1;
    transform: none;
  }

  to {
    opacity: 0;
    transform: scale(0.78) rotate(-4deg);
    filter: grayscale(1);
  }
}
</style>
