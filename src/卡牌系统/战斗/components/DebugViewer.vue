<!-- 战斗调试弹窗: 面板发给酒馆 AI 的注入文本 / AI 的回复 / 变量快照 -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <BattleModal title="战斗调试" :subtitle="`协议 v${PROTOCOL_VERSION}`" wide @close="emit('close')">
    <!-- ============ 世界书条目 ============ -->
    <section class="db-sec">
      <div class="db-sec-head">
        <span class="db-sec-title">世界书条目</span>
        <span class="db-tag" :class="worldbookTone">{{ worldbookText }}</span>
        <span v-if="worldbook && worldbook.已安装" class="db-sec-note">
          装在: {{ worldbook.所在世界书.join(' / ') }}
        </span>
        <span class="db-chips">
          <button class="db-chip" type="button" @click="emit('refresh')">重新检测</button>
        </span>
      </div>
      <p class="db-tip">
        条目「{{ BATTLE_ENTRY_NAME }}」由酒馆按下面的条件渲染；未安装或内容过期时，AI
        收不到任何战斗提示。面板上那条世界书提示关掉之后，就在这里看状态、重新检测。
      </p>
    </section>

    <!-- ============ 面板 → AI ============ -->
    <section class="db-sec">
      <div class="db-sec-head">
        <span class="db-sec-title">面板 → AI 的注入内容</span>
        <span class="db-tag ok">{{ activeCount }} / {{ info.segments.length }} 段生效</span>
        <span v-if="info.practice" class="db-tag warn">演习模式: 不会影响正式战斗</span>
      </div>
      <p class="db-tip">
        这就是 AI 实际收到的内容；灰色的段没有生效，不会占上下文。
      </p>

      <div
        v-for="segment in info.segments"
        :key="segment.title"
        class="db-block"
        :class="{ off: !segment.active }"
      >
        <div class="db-block-head">
          <span class="db-block-title">{{ segment.title }}</span>
          <code class="db-cond">{{ segment.condition }}</code>
          <span class="db-state" :class="{ bad: !segment.active }">
            {{ segment.active ? '已注入' : '未注入' }}
          </span>
        </div>
        <pre v-if="segment.active" class="db-pre">{{ segment.text }}</pre>
        <p v-else class="db-empty">条件不成立，这一段不会出现在提示词里。</p>
      </div>
    </section>

    <!-- ============ AI → 面板 ============ -->
    <section class="db-sec">
      <div class="db-sec-head">
        <span class="db-sec-title">AI → 面板的回复</span>
        <span class="db-chips">
          <button
            v-for="count in DEBUG_REPLY_LIMITS"
            :key="count"
            class="db-chip"
            type="button"
            :class="{ on: replyLimit === count }"
            @click="emit('update:replyLimit', count)"
          >
            {{ count }} 条
          </button>
        </span>
      </div>
      <p class="db-tip">
        最近的 AI 回复原文，以及从每条里提取到的决策（提取失败时战斗不会推进）。
      </p>

      <p v-if="info.replies.length === 0" class="db-empty">还没读到 AI 楼层。</p>
      <div v-for="reply in info.replies" :key="reply.message_id" class="db-block">
        <div class="db-block-head">
          <span class="db-block-title">#{{ reply.message_id }}</span>
          <span class="db-state" :class="{ bad: !reply.decision_ok }">
            {{ reply.decision_ok ? `✔ 提取到决策 (${reply.ops} 条操作)` : `✖ ${reply.decision_error}` }}
          </span>
        </div>
        <pre class="db-pre">{{ reply.text || '(空楼层)' }}</pre>
        <pre v-if="reply.decision_raw" class="db-pre raw">{{ reply.decision_raw }}</pre>
      </div>
    </section>

    <!-- ============ 结算 ============ -->
    <section class="db-sec">
      <div class="db-sec-head">
        <span class="db-sec-title">AI 决策的结算结果</span>
      </div>
      <p class="db-tip">下面是本次会话里每次结算的留档（刷新页面后清空）。</p>
      <pre class="db-pre">{{ info.result || '(还没有结算过)' }}</pre>
      <div v-if="info.decisions.length > 0" class="db-list">
        <div v-for="(line, index) in info.decisions" :key="index" class="db-list-item">{{ line }}</div>
      </div>
    </section>

    <!-- ============ 回放 ============ -->
    <section v-if="info.replay" class="db-sec">
      <div class="db-sec-head">
        <span class="db-sec-title">战斗回放</span>
        <span class="db-tag" :class="info.replay.一致 ? 'ok' : 'warn'">
          {{ info.replay.一致 ? '重放一致' : '重放不一致' }}
        </span>
        <span class="db-sec-note">{{ info.replay.有起点 ? '从起点快照重演' : '从开局重演' }}</span>
      </div>
      <p class="db-tip">
        回合是按「起点 + 每一步操作」重演出来的：面板上的「回溯」与「重新生成后自动回退」都靠它。
      </p>
      <div class="db-kv">
        <span>共 {{ info.replay.总数 }} 步</span>
        <span v-if="info.replay.已丢弃 > 0">已合并 {{ info.replay.已丢弃 }} 步进起点</span>
        <span>约 {{ formatSize(info.replay.体积.合计) }}</span>
        <span>明细: 步骤 {{ formatSize(info.replay.体积.步骤) }} / 起点 {{ formatSize(info.replay.体积.起点) }}</span>
        <span>单步均 {{ formatSize(info.replay.体积.平均每步) }}</span>
      </div>
      <p v-if="!info.replay.一致" class="db-empty">
        {{ info.replay.说明 || '重放出来的局面与当前不一致' }}
      </p>
      <div v-if="replayRows.length > 0" class="db-list">
        <div v-for="line in replayRows" :key="line.序号" class="db-list-item" :class="{ anchor: line.锤点 }">
          <span class="db-seq">#{{ line.序号 }}</span>{{ line.文本 }}
        </div>
      </div>
      <p v-else class="db-empty">还没有记录到任何操作。</p>
    </section>

    <!-- ============ 操作与变量 ============ -->
    <section class="db-sec">
      <div class="db-sec-head">
        <span class="db-sec-title">本回合操作记录</span>
        <span class="db-sec-note">会随简报一起发给 AI</span>
      </div>
      <pre class="db-pre">{{ info.ops.join('\n') || '(空)' }}</pre>
    </section>

    <section class="db-sec">
      <div class="db-sec-head">
        <span class="db-sec-title">变量快照</span>
        <span v-if="info.store_truncated" class="db-tag warn">已截断展示</span>
      </div>
      <p class="db-tip">脚本每次同步都会重算这份数据；格式不对时会按默认值处理。</p>
      <pre class="db-pre json">{{ info.store_json }}</pre>
    </section>
  </BattleModal>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { formatSize } from '../../共用/体积.ts';
import { PROTOCOL_VERSION } from '../协议.ts';
import { DEBUG_REPLY_LIMITS, type BattleDebugInfo } from '../调试.ts';
import { BATTLE_ENTRY_NAME, type BattleWorldbookStatus } from '../世界书.ts';
import BattleModal from './BattleModal.vue';

const props = defineProps<{
  info: BattleDebugInfo;
  /** 世界书条目安装状态; 还没检测出来时为 null */
  worldbook: BattleWorldbookStatus | null;
  /** 当前显示多少条 AI 回复 */
  replyLimit: number;
}>();

const emit = defineEmits<{ close: []; 'update:replyLimit': [value: number]; refresh: [] }>();

const activeCount = computed(() => props.info.segments.filter(segment => segment.active).length);

const worldbookText = computed(() => {
  const status = props.worldbook;
  if (!status) {
    return '检测中…';
  }
  if (!status.已安装) {
    return '未安装: AI 收不到决策提示';
  }
  return status.最新 ? '已安装且为最新' : '旧版本: 请重新导入 世界书-卡牌战斗.json';
});

const worldbookTone = computed(() => {
  const status = props.worldbook;
  if (!status) {
    return '';
  }
  return status.已安装 && status.最新 ? 'ok' : 'warn';
});

/** 回放步骤倒着列 (最新的在最上面) */
const replayRows = computed(() => (props.info.replay ? [...props.info.replay.步骤].reverse() : []));
</script>

<style scoped>
.db-sec {
  margin-bottom: 16px;
}

.db-sec:last-child {
  margin-bottom: 0;
}

.db-sec-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.db-sec-title {
  font-size: 0.95em;
  font-weight: 600;
}

.db-sec-note {
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.76em;
}

.db-tag {
  padding: 1px 9px;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.08);
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.76em;
}

.db-tag.ok {
  background: rgb(120 200 150 / 0.2);
  color: #a6e3b8;
}

.db-tag.warn {
  background: rgb(240 180 100 / 0.2);
  color: #f0c88a;
}

.db-tip {
  margin: 5px 0 7px;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.76em;
  line-height: 1.55;
}

.db-tip code {
  padding: 0 3px;
  border-radius: 4px;
  background: rgb(0 0 0 / 0.3);
  font-family: ui-monospace, 'Cascadia Mono', monospace;
}

.db-block {
  margin-bottom: 7px;
  padding: 8px 10px;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.1));
  border-radius: 9px;
  background: rgb(255 255 255 / 0.035);
}

.db-block.off {
  opacity: 0.6;
}

.db-block-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
  font-size: 0.84em;
}

.db-block-title {
  font-weight: 600;
}

.db-cond {
  padding: 1px 6px;
  border-radius: 5px;
  background: rgb(0 0 0 / 0.3);
  color: var(--bt-text-secondary, #a0a0b0);
  font-family: ui-monospace, 'Cascadia Mono', monospace;
  font-size: 0.92em;
}

.db-state {
  margin-left: auto;
  color: #a6e3b8;
  font-size: 0.94em;
}

.db-state.bad {
  color: #f0c88a;
}

.db-pre {
  max-height: 260px;
  margin: 0;
  padding: 7px 9px;
  border-radius: 7px;
  background: rgb(0 0 0 / 0.28);
  color: inherit;
  font-family: ui-monospace, 'Cascadia Mono', monospace;
  font-size: 0.8em;
  line-height: 1.55;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.db-pre + .db-pre {
  margin-top: 5px;
}

.db-pre.raw {
  border-left: 2px solid rgb(203 166 247 / 0.6);
}

.db-pre.json {
  max-height: 320px;
}

.db-empty {
  margin: 0;
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.8em;
}

.db-chips {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.db-chip {
  padding: 2px 9px;
  border: 1px solid var(--bt-border, rgb(255 255 255 / 0.12));
  border-radius: 999px;
  background: rgb(255 255 255 / 0.05);
  color: inherit;
  font-family: inherit;
  font-size: 0.8em;
  cursor: pointer;
}

.db-chip:hover {
  background: rgb(255 255 255 / 0.13);
}

.db-chip.on {
  border-color: rgb(137 180 250 / 0.55);
  background: rgb(137 180 250 / 0.24);
  color: #cddcff;
}

.db-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 6px;
}

.db-list-item {
  padding: 5px 8px;
  border-radius: 7px;
  background: rgb(255 255 255 / 0.035);
  font-size: 0.8em;
  line-height: 1.5;
  white-space: pre-wrap;
}

.db-kv {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.db-kv span {
  padding: 2px 8px;
  border-radius: 7px;
  background: rgb(0 0 0 / 0.26);
  color: var(--bt-text-secondary, #a0a0b0);
  font-size: 0.78em;
}

.db-list-item.anchor {
  border-left: 2px solid rgb(137 180 250 / 0.55);
}

.db-seq {
  margin-right: 5px;
  color: var(--bt-text-secondary, #a0a0b0);
  font-variant-numeric: tabular-nums;
}
</style>
