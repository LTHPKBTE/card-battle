<!-- 数据迁移弹窗 (卡牌库 / 卡组共用): 选目标位置 + 移动或复制 + 缩小范围时的提醒 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes, better-tailwindcss/no-concatenated-classes -->
<template>
  <div class="mg-mask" @click.self="emit('关闭')">
    <div class="mg" role="dialog" aria-modal="true">
      <div class="mg-title">{{ 标题 }}</div>
      <p v-if="说明" class="mg-hint">{{ 说明 }}</p>

      <div class="mg-group">
        <div class="mg-group-title">放到哪里</div>
        <label v-for="layer in DATA_LAYERS" :key="layer" class="mg-option" :class="{ off: !isAvailable(layer) }">
          <input v-model="目标" type="radio" :value="layer" :disabled="!isAvailable(layer)" />
          <span class="mg-option-main">
            <b>{{ layer }}</b>
            <small>{{ LAYER_HINTS[layer] }}</small>
          </span>
        </label>
      </div>

      <div class="mg-group">
        <div class="mg-group-title">怎么放</div>
        <label class="mg-option">
          <input v-model="方式" type="radio" value="move" />
          <span class="mg-option-main">
            <b>移动</b>
            <small>原来的位置不再保留, 只有这一个地方能用</small>
          </span>
        </label>
        <label class="mg-option">
          <input v-model="方式" type="radio" value="copy" />
          <span class="mg-option-main">
            <b>复制</b>
            <small>两边各留一份, 之后改哪一边都只影响那一边 (互不相干)</small>
          </span>
        </label>
      </div>

      <div v-if="缺卡数 > 0" class="mg-group">
        <div class="mg-group-title">用的卡牌</div>
        <label class="mg-option">
          <input v-model="带卡牌" type="radio" :value="true" />
          <span class="mg-option-main">
            <b>一并迁移用到的 {{ 缺卡数 }} 张卡</b>
            <small>这些卡在新的位置本来就看不到, 一起带过去才能正常出战</small>
          </span>
        </label>
        <label class="mg-option">
          <input v-model="带卡牌" type="radio" :value="false" />
          <span class="mg-option-main">
            <b>只迁移卡组</b>
            <small>卡牌留在原处, 在新位置可能会缺卡 (卡组仍能出战, 缺的会被跳过)</small>
          </span>
        </label>
      </div>

      <div v-if="警告" class="mg-warn">
        这次是往范围更小的地方搬: 搬到「{{ 目标 }}」之后, {{ 缩小自 }}里的东西在别的地方就用不上了。
      </div>

      <label class="mg-keep">
        <input v-model="不再提示" type="checkbox" />
        <span>缩小范围时不再提示我</span>
      </label>

      <div class="mg-actions">
        <button class="mg-btn" type="button" @click="emit('关闭')">取消</button>
        <button class="mg-btn primary" type="button" @click="确认">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  DATA_LAYERS,
  LAYER_HINTS,
  availableLayers,
  isNarrowing,
  layerRank,
  loadLayerSettings,
  saveLayerSettings,
  type DataLayer,
} from './层级';

const props = defineProps<{
  /** 弹窗标题 (例如「迁移 3 张卡牌」) */
  标题: string;
  /** 这些东西现在分别在哪些位置 */
  来源: DataLayer[];
  /** 标题下面的一句说明 */
  说明?: string;
  /** 目标位置默认选哪个 (省略时用「新建位置」里选的层) */
  默认目标?: DataLayer;
  /** 迁移卡组时: 给定目标位置算一下那儿用不上的卡牌张数 (0 表示不用问「要不要带卡」) */
  缺卡估算?: (layer: DataLayer) => number;
}>();

const emit = defineEmits<{
  关闭: [];
  确认: [choice: { 目标: DataLayer; 方式: 'move' | 'copy'; 一并迁移卡牌: boolean }];
}>();

const 可用 = availableLayers();
function isAvailable(layer: DataLayer): boolean {
  return 可用.includes(layer);
}

const 目标 = ref<DataLayer>(
  props.默认目标 && 可用.includes(props.默认目标) ? props.默认目标 : (可用[可用.length - 1] ?? '聊天'),
);
const 方式 = ref<'move' | 'copy'>('move');
/** 目标位置用不上的卡牌张数 (卡组才会用到) */
const 缺卡数 = computed(() => {
  const count = props.缺卡估算?.(目标.value) ?? 0;
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
});
const 带卡牌 = ref(true);

const 设置 = loadLayerSettings();
const 不再提示 = ref(设置.缩小时不再提示);

/** 被搬的东西里范围最大的那一层 (用来判断「缩小范围」) */
const 最宽来源 = computed<DataLayer>(() => {
  const list = props.来源.length ? props.来源 : ['聊天' as DataLayer];
  return list.reduce((a, b) => (layerRank(a) >= layerRank(b) ? a : b));
});

/** 缩小自哪一层 (只在「移动 + 缩小」时才有说头) */
const 缩小自 = computed(() => 最宽来源.value);

const 缩小 = computed(() => props.来源.some(layer => isNarrowing(layer, 目标.value)));

/** 是否真要提醒 (关掉提醒之后就不再弹这句话) */
const 警告 = computed(() => 方式.value === 'move' && 缩小.value && !不再提示.value);

function 确认() {
  if (不再提示.value !== 设置.缩小时不再提示) {
    saveLayerSettings({ 缩小时不再提示: 不再提示.value });
  }
  emit('确认', { 目标: 目标.value, 方式: 方式.value, 一并迁移卡牌: 缺卡数.value > 0 && 带卡牌.value });
}
</script>

<style scoped lang="scss">
.mg-mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 20;
}

.mg {
  box-sizing: border-box;
  width: min(520px, 100%);
  max-height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  border-radius: 12px;
  border: 1px solid rgb(255 255 255 / 0.14);
  background: rgb(var(--panel-tint, 22 24 33) / 0.96);
  backdrop-filter: blur(var(--panel-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-blur, 10px));
  box-shadow: 0 18px 50px rgb(0 0 0 / 0.5);
  color: #e6e9f0;
  font-size: 0.9em;
}

.mg-title {
  font-size: 1.1em;
  font-weight: 700;
}

.mg-hint {
  margin: 0;
  font-size: 0.85em;
  line-height: 1.6;
  color: rgb(255 255 255 / 0.55);
}

.mg-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mg-group-title {
  font-size: 0.78em;
  letter-spacing: 0.06em;
  color: rgb(255 255 255 / 0.45);
}

.mg-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 0.1);
  background: rgb(255 255 255 / 0.03);
  cursor: pointer;

  input {
    margin: 2px 0 0;
    accent-color: #89b4fa;
  }

  &.off {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

.mg-option-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.5;

  b {
    font-weight: 600;
  }

  small {
    font-size: 0.85em;
    color: rgb(255 255 255 / 0.5);
  }
}

.mg-warn {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgb(249 226 175 / 0.35);
  background: rgb(249 226 175 / 0.1);
  color: #f9e2af;
  font-size: 0.85em;
  line-height: 1.6;
}

.mg-keep {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8em;
  color: rgb(255 255 255 / 0.5);
  cursor: pointer;

  input {
    accent-color: #89b4fa;
  }
}

.mg-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.mg-btn {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 0.16);
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  font-size: 0.9em;
  cursor: pointer;

  &:hover {
    background: rgb(255 255 255 / 0.12);
  }

  &.primary {
    border-color: rgb(137 180 250 / 0.6);
    background: rgb(137 180 250 / 0.22);
    color: #cfe0ff;

    &:hover {
      background: rgb(137 180 250 / 0.32);
    }
  }
}
</style>
