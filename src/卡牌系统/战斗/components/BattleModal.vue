<!-- 战斗面板内的通用弹窗外壳 (卡牌详情 / 牌库 / 日志共用) -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <div class="bmd-mask" :class="{ 'is-top': layer === 'top' }" @click.self="emit('close')">
    <div class="bmd-box" :class="{ wide, 'is-top': layer === 'top' }" role="dialog" aria-modal="true">
      <header class="bmd-head">
        <span class="bmd-title">{{ title }}</span>
        <span v-if="subtitle" class="bmd-sub">{{ subtitle }}</span>
        <span class="bmd-spacer" />
        <slot name="actions" />
        <button class="bmd-close" type="button" title="关闭" @click="emit('close')">✕</button>
      </header>
      <div class="bmd-body">
        <slot />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    /** 宽弹窗 (牌库 / 日志用) */
    wide?: boolean;
    /**
     * 层级: base 是普通弹窗, top 是「从弹窗里再打开的弹窗」(牌库/墓地里点卡看详情).
     * 文档顺序里后写的会盖住先写的, 但牌库是后写在详情后面的, 所以详情必须自己抬一层.
     */
    layer?: 'base' | 'top';
  }>(),
  { subtitle: '', wide: false, layer: 'base' },
);

const emit = defineEmits<{ close: [] }>();
</script>

<style scoped>
.bmd-mask {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  background: rgb(4 5 8 / 0.62);
}

/* 从另一个弹窗里打开的 (卡牌详情) 抬到最高一层, 否则会被牌库/日志盖住 */
.bmd-mask.is-top {
  z-index: 45;
}

.bmd-box {
  display: flex;
  flex-direction: column;
  width: min(520px, 100%);
  max-height: 100%;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.12));
  border-radius: 14px;
  /* 弹窗的不透明度 / 模糊单独一档 (见 共用/外观.ts): 弹窗里都是要读的字, 默认比面板实 */
  background: rgb(var(--panel-tint, 22 24 33) / var(--panel-dialog-alpha, 0.96));
  backdrop-filter: blur(var(--panel-dialog-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-dialog-blur, 10px));
  box-shadow: 0 22px 70px rgb(0 0 0 / 0.62);
  overflow: hidden;
}

.bmd-box.wide {
  width: min(860px, 100%);
}

.bmd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bt-border, rgb(255 255 255 / 0.1));
}

.bmd-title {
  font-size: 1.05em;
  font-weight: 700;
}

.bmd-sub {
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.82em;
}

.bmd-spacer {
  flex: 1;
}

.bmd-close {
  width: 26px;
  height: 26px;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.1));
  border-radius: 7px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-size: 0.8em;
  line-height: 1;
  cursor: pointer;
}

.bmd-close:hover {
  background: rgb(255 255 255 / 0.16);
}

.bmd-body {
  padding: 14px;
  overflow-y: auto;
}
</style>
