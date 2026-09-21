<!-- 牌库 / 墓地 / 除外 查看弹窗 (演习模式可以直接上场) -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <BattleModal :title="`${sideLabel}${zoneLabel}`" :subtitle="`${cards.length} 张`" wide @close="emit('close')">
    <p class="pv-hint">
      <template v-if="practice">演习模式: 点击一行查看详情, 点「上场」直接放到场上空位。</template>
      <template v-else>正式战斗只能查看自己这边的牌堆, 不能操作。</template>
    </p>

    <div v-if="cards.length" class="pv-list">
      <div
        v-for="card in cards"
        :key="card.id"
        class="pv-row"
        @click="emit('inspect', card)"
      >
        <span class="pv-rarity" :class="`pv-r-${card.rarity}`">{{ card.rarity }}</span>
        <span class="pv-name" :title="card.name">{{ card.name }}</span>
        <span class="pv-stat">攻 {{ card.current.atk }}</span>
        <span class="pv-stat">盾 {{ card.current.shield }}/{{ card.current.shield_max }}</span>
        <span class="pv-stat hp">HP {{ card.current.hp }}/{{ card.current.hp_max }}</span>
        <span class="pv-spacer" />
        <button
          v-if="practice && allowPlay"
          class="pv-btn"
          type="button"
          @click.stop="emit('play', card)"
        >
          上场
        </button>
        <span class="pv-more">详情 ›</span>
      </div>
    </div>
    <p v-else class="pv-empty">{{ emptyText }}</p>
  </BattleModal>
</template>

<script setup lang="ts">
import type { CardInstance } from '../../引擎/types.ts';
import BattleModal from './BattleModal.vue';

withDefaults(
  defineProps<{
    /** 「我方」/「敌方」 */
    sideLabel: string;
    /** 「牌库」/「墓地」/「除外」 */
    zoneLabel: string;
    cards: CardInstance[];
    /** 是否演习模式 (允许上场) */
    practice?: boolean;
    /** 场上是否还有空位 */
    allowPlay?: boolean;
    emptyText?: string;
  }>(),
  { practice: false, allowPlay: false, emptyText: '这里是空的。' },
);

const emit = defineEmits<{ close: []; inspect: [card: CardInstance]; play: [card: CardInstance] }>();
</script>

<style scoped>
.pv-hint {
  margin: 0 0 10px;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.84em;
}

.pv-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pv-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 9px;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.1));
  border-radius: 9px;
  background: rgb(255 255 255 / 0.04);
  font-size: 0.88em;
  cursor: pointer;
}

.pv-row:hover {
  background: rgb(255 255 255 / 0.1);
}

.pv-rarity {
  flex: none;
  min-width: 2.2em;
  padding: 1px 5px;
  border-radius: 5px;
  background: rgb(137 180 250 / 0.18);
  color: var(--bt-accent, #89b4fa);
  font-size: 0.82em;
  text-align: center;
}

.pv-r-UR {
  background: rgb(245 194 231 / 0.22);
  color: #f5c2e7;
}

.pv-r-SSR {
  background: rgb(249 226 175 / 0.2);
  color: #f9e2af;
}

.pv-r-SR {
  background: rgb(166 227 161 / 0.18);
  color: #a6e3a1;
}

.pv-name {
  flex: 1 1 8em;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.pv-stat {
  flex: none;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.94em;
}

.pv-stat.hp {
  color: #a6e3a1;
}

.pv-spacer {
  flex: 0 0 4px;
}

.pv-more {
  flex: none;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.84em;
}

.pv-btn {
  flex: none;
  padding: 3px 10px;
  border: 1px solid rgb(137 180 250 / 0.5);
  border-radius: 7px;
  background: rgb(137 180 250 / 0.24);
  color: inherit;
  font-family: inherit;
  font-size: 0.84em;
  cursor: pointer;
}

.pv-btn:hover {
  background: rgb(137 180 250 / 0.4);
}

.pv-empty {
  margin: 18px 0;
  color: var(--bt-text-secondary, #a0a0b0);
  text-align: center;
  font-size: 0.88em;
}
</style>
