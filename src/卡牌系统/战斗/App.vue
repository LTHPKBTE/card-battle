<!-- 战斗操作面板: 独立浮层, 不写入聊天记录 (聊天里只有 AI 的决策块) -->
<!-- eslint-disable better-tailwindcss/no-unknown-classes -->
<template>
  <div class="bt-overlay" :class="{ 'is-narrow': isNarrow }" :style="lookStyle">
    <div class="bt-main">
      <header class="bt-header">
        <span class="bt-title">战斗</span>
        <span v-if="modeLabel" class="bt-badge" :class="{ practice: practice }">{{ modeLabel }}</span>
        <span class="bt-spacer" />
        <button class="bt-btn" type="button" :class="{ primary: showLogs }" @click="showLogs = true">
          日志<span v-if="logCount" class="bt-count">{{ logCount }}</span>
        </button>
        <button class="bt-btn" type="button" :class="{ primary: showLook }" @click="showLook = !showLook">
          外观
        </button>
        <button class="bt-btn" type="button" @click="showSettings = !showSettings">设置</button>
        <button class="bt-btn" type="button" :class="{ primary: showDebug }" @click="showDebug = !showDebug">
          调试
        </button>
        <button class="bt-close" type="button" @click="requestClose">✕ 关闭</button>
      </header>

      <!-- 垫底色 / 模糊半径 (三个面板共用同一份设置) -->
      <PanelLookSettings v-if="showLook" @close="showLook = false" />

      <!-- 设置 -->
      <section v-if="showSettings" class="bt-settings">
        <label class="bt-switch" :title="practice ? '演习模式本来就是两边都能操作' : ''">
          <input type="checkbox" :checked="bothSides" :disabled="practice" @change="toggleBothSides" />
          <span>双方操控 (玩家同时操作两边)</span>
        </label>
        <label
          v-if="practice"
          class="bt-switch"
          title="演习不写变量, 所以可以随时改; 正式战斗的能量在开局设置里定死"
        >
          <input type="checkbox" :checked="energySwitch" @change="togglePracticeEnergy" />
          <span>上场消耗能量</span>
        </label>
        <label class="bt-switch">
          <input v-model="dragEnabled" type="checkbox" />
          <span>启用拖放操作{{ isNarrow ? ' (窄屏已自动关闭)' : '' }}</span>
        </label>
        <label class="bt-switch" title="关掉后不再播抽卡 / 攻击 / 技能 / 倒下的动画, 可发动技能的卡也不再亮光边">
          <input v-model="animEnabled" type="checkbox" />
          <span>卡牌动效 (动画 + 高亮光边)</span>
        </label>
        <span class="bt-settings-hint">
          关闭拖放后, 点击卡牌 → 选择动作 → 点击目标即可完成同样的操作 (手机推荐).
        </span>
        <label class="bt-pace" title="AI 决策里的每一个操作 (上场 / 攻击 / 发动) 播完停多久; 0 = 不播">
          <span>AI 操作间隔</span>
          <NumberField
            v-model="paceAction"
            :min="0"
            :max="MAX_BATTLE_INTERVAL"
            :fallback="DEFAULT_ACTION_INTERVAL"
          />
          <span class="bt-pace-unit">毫秒</span>
        </label>
        <label class="bt-pace" title="回合结算里每一件事 (触发技能 / 持续伤害 / 卡牌倒下) 播完停多久; 0 = 不播">
          <span>结算间隔</span>
          <NumberField
            v-model="paceSettle"
            :min="0"
            :max="MAX_BATTLE_INTERVAL"
            :fallback="DEFAULT_SETTLE_INTERVAL"
          />
          <span class="bt-pace-unit">毫秒</span>
        </label>
        <span class="bt-settings-hint">现在: {{ playbackHint }} (1000 毫秒 = 1 秒; 0 = 不播)</span>
      </section>

      <!-- 播放条与提示都在下面的浮动提示层里 (它们不占布局, 不会挤动卡牌) -->

      <!-- ============ 未开始: 配置 ============ -->
      <div v-if="!state" class="bt-setup">
        <p class="bt-setup-title">开一场战斗</p>

        <div class="bt-setup-row">
          <label for="bt-player-deck">我方卡组</label>
          <select id="bt-player-deck" v-model="playerDeckId">
            <option v-for="deck in playerDecks" :key="deck.id" :value="deck.id">
              {{ deck.名称 || '未命名卡组' }} ({{ deck.卡牌.length }})
            </option>
          </select>
        </div>

        <div class="bt-setup-row">
          <label for="bt-enemy-deck">敌方卡组</label>
          <select id="bt-enemy-deck" v-model="enemyDeckId">
            <option v-if="enemyDecks.length === 0" value="__same__">同我方卡组</option>
            <option v-for="deck in enemyDecks" :key="deck.id" :value="deck.id">
              {{ deck.名称 || '未命名卡组' }} ({{ deck.卡牌.length }})
            </option>
          </select>
        </div>

        <details class="bt-advanced">
          <summary>高级设置</summary>
          <div class="bt-advanced-grid">
            <label>我方生命 <NumberField v-model="hpPlayer" :min="1" :fallback="8000" /></label>
            <label>敌方生命 <NumberField v-model="hpEnemy" :min="1" :fallback="8000" /></label>
            <label>开局手牌 <NumberField v-model="openingHand" :min="0" :fallback="5" /></label>
            <label>手牌上限 <NumberField v-model="handLimit" :min="0" :fallback="8" /></label>
            <label>场上上限 <NumberField v-model="fieldLimit" :min="1" :max="10" :fallback="5" /></label>
            <label>起始能量 <NumberField v-model="energyStart" :min="0" :fallback="1" /></label>
            <label>能量增长 <NumberField v-model="energyPerTurn" :min="0" :fallback="1" /></label>
            <label>能量上限 <NumberField v-model="energyCap" :min="0" :fallback="10" /></label>
            <label class="bt-check" title="关掉后所有卡都能直接上场, 不用算资源">
              <input v-model="energySwitch" type="checkbox" />
              上场消耗能量
            </label>
            <label class="bt-check" title="关掉后每回合只补「上限涨的那部分」, 花掉的能量不会回来">
              <input v-model="energyRefill" type="checkbox" />
              行动时补满能量
            </label>
            <label>随机种子 <NumberField v-model="seed" :fallback="1" /></label>
            <label>
              先手
              <select v-model="first">
                <option value="PLAYER">我方</option>
                <option value="ENEMY">敌方</option>
              </select>
            </label>
            <label>
              牌库轮换
              <select v-model="recycle">
                <option value="GRAVEYARD">墓地洗回</option>
                <option value="NONE">不轮换</option>
              </select>
            </label>
            <label title="每方轮到自己行动的瞬间抽几张; 0 = 只在开局发牌 (先手方第 1 回合不抽)">
              每回合抽牌 <NumberField v-model="drawPerTurn" :min="0" :max="10" :fallback="1" />
            </label>
            <label title="每场最多把墓地洗回牌库几次; 0 = 不限 (用完牌库抽空就真的抽不到牌)">
              洗牌上限 <NumberField v-model="recycleLimit" :min="0" :fallback="0" />
            </label>
            <label title="每洗一次牌, 该方之后上场的卡永久加价这么多能量; 0 = 无代价">
              洗牌加价 <NumberField v-model="recyclePenalty" :min="0" :fallback="1" />
            </label>
            <label
              class="bt-check"
              title="对手场上还有卡时, 普通攻击不能直接打对手本人 (效果伤害不受限制; 卡面写了「无视守卫」的攻击可以越过)"
            >
              <input v-model="guardRule" type="checkbox" />
              场上还有卡就不能打脸
            </label>
            <label title="打死一张卡时, 超出它剩余生命的那部分伤害按这个比例传给它的控制者 (0 = 不传, 1 = 全额)">
              溢出传伤比例
              <NumberField v-model="splashRatio" :min="0" :max="1" :integer="false" :fallback="0.5" />
            </label>
            <label title="打满这么多回合后按双方剩余生命比例判定胜负; 0 = 不限">
              回合上限 <NumberField v-model="turnLimit" :min="0" :fallback="30" />
            </label>
          </div>
        </details>

        <div class="bt-setup-actions">
          <button class="bt-btn primary" type="button" :disabled="playerDecks.length === 0" @click="startBattle">
            开始战斗
          </button>
          <button class="bt-btn" type="button" :disabled="playerDecks.length === 0" @click="startPractice">
            演习模式
          </button>
        </div>

        <p v-if="playerDecks.length === 0" class="bt-note">还没有我方卡组, 请先到「卡组」面板里创建一个。</p>
        <p v-else-if="enemyDecks.length === 0" class="bt-note">
          还没有敌方卡组: 可以到「卡组」面板新建一个敌方卡组, 或用「AI 生成卡组」自动生成。
        </p>
        <p v-else class="bt-note">
          战斗时 AI 会在敌方回合行动; 演习模式只在面板里进行, 不会打扰当前对话。
        </p>
      </div>

      <!-- ============ 战斗中 ============ -->
      <template v-else>
        <div class="bt-body">
          <!-- 敌方 -->
          <section class="bt-side" :class="{ active: state.active === 'ENEMY' }">
            <div class="bt-piles">
              <button
                class="bt-pile deck"
                type="button"
                :disabled="!canViewPile('ENEMY', 'DECK')"
                :title="canViewPile('ENEMY', 'DECK') ? '查看敌方牌库' : '正式战斗看不到敌方牌库'"
                @click="openPile('ENEMY', 'DECK')"
              >
                <span class="bt-pile-label">牌库</span><b>{{ state.players.ENEMY.deck.length }}</b>
              </button>
              <button
                :key="`grave-ENEMY-${gravePulse.ENEMY ?? 0}`"
                class="bt-pile grave"
                :class="{ 'is-pulse': Boolean(gravePulse.ENEMY) }"
                type="button"
                :title="canViewPile('ENEMY', 'GRAVEYARD') ? '查看敌方墓地' : '看不到敌方墓地'"
                @click="openPile('ENEMY', 'GRAVEYARD')"
              >
                <span class="bt-pile-label">墓地</span><b>{{ state.players.ENEMY.graveyard.length }}</b>
              </button>
              <button
                v-if="state.players.ENEMY.banished.length"
                class="bt-pile gone"
                type="button"
                @click="openPile('ENEMY', 'BANISHED')"
              >
                <span class="bt-pile-label">除外</span><b>{{ state.players.ENEMY.banished.length }}</b>
              </button>
            </div>

            <div class="bt-zone hand">
              <div class="bt-zone-head">
                <span class="bt-zone-name">手牌</span>
                <span class="bt-zone-meta">{{ state.players.ENEMY.hand.length }} 张</span>
              </div>
              <div class="bt-hand">
                <template v-if="showHand('ENEMY')">
                  <div
                    v-for="card in handCards('ENEMY')"
                    :key="card.id"
                    class="bt-card-wrap hand"
                    :draggable="draggableCard(card)"
                    @dragstart="onDragStart(card, $event)"
                    @dragend="onDragEnd"
                    @click.stop="onCardClick(card)"
                    @contextmenu.prevent="inspectCard(card)"
                  >
                    <BattleCard
                      :card="card"
                      :statuses="statusList(card)"
                      :selected="selectionCardId === card.id"
                      :inactive="!canOperate(card.controller)"
                      :ready="readyIds.has(card.id)"
                      :fx-kind="fxKindOf(card.id)"
                      :fx-serial="fxSerialOf(card.id)"
                      :fx-text="fxTextOf(card.id)"
                    />
                  </div>
                  <span v-if="handCards('ENEMY').length === 0" class="bt-empty">敌方没有手牌</span>
                </template>
                <template v-else>
                  <div v-for="n in state.players.ENEMY.hand.length" :key="`eh${n}`" class="bt-hidden-card">?</div>
                  <span v-if="state.players.ENEMY.hand.length === 0" class="bt-empty">敌方没有手牌</span>
                </template>
              </div>
            </div>

            <div class="bt-zone field">
              <div class="bt-zone-head">
                <span class="bt-zone-name">场上</span>
                <span class="bt-zone-meta">{{ fieldCount('ENEMY') }} / {{ fieldSize }}</span>
              </div>
              <div class="bt-field" @dragover.prevent @drop.prevent="onFieldDrop('ENEMY', $event)">
                <div
                  v-for="(slot, index) in fieldSlots('ENEMY')"
                  :key="`e${index}`"
                  class="bt-slot"
                  :class="{ empty: !slot, 'drop-hint': canDropOnSlot('ENEMY', index) }"
                  @dragover.prevent
                  @drop.prevent="onSlotDrop('ENEMY', index, $event)"
                  @click="onSlotClick('ENEMY', index)"
                >
                  <div
                    v-if="slot"
                    class="bt-card-wrap"
                    :class="{ ghost: isGhostCard(slot) }"
                    :draggable="draggableCard(slot)"
                    @dragstart="onDragStart(slot, $event)"
                    @dragend="onDragEnd"
                    @click.stop="onCardClick(slot)"
                    @contextmenu.prevent="inspectCard(slot)"
                  >
                    <BattleCard
                      :card="slot"
                      :statuses="statusList(slot)"
                      :selected="selectionCardId === slot.id"
                      :targetable="isTargetable(slot)"
                      :inactive="!canOperate(slot.controller)"
                      :ready="readyIds.has(slot.id)"
                      :fx-kind="fxKindOf(slot.id)"
                      :fx-serial="fxSerialOf(slot.id)"
                      :fx-text="fxTextOf(slot.id)"
                    />
                  </div>
                  <span v-else class="bt-slot-empty">{{ index + 1 }}</span>
                </div>
              </div>
            </div>

            <div
              :key="`panel-ENEMY-${sideSerial('ENEMY')}`"
              class="bt-player"
              :class="{
                targetable: isPanelTargetable('ENEMY'),
                'is-hurt': sideKind('ENEMY') === 'hit',
                'is-heal': sideKind('ENEMY') === 'heal',
              }"
              @click="onPanelClick('ENEMY')"
              @dragover.prevent
              @drop.prevent="onPanelDrop('ENEMY')"
            >
              <span v-if="sideText('ENEMY')" class="bt-float">{{ sideText('ENEMY') }}</span>
              <span class="bt-side-name">敌方</span>
              <span class="bt-hp">HP {{ state.players.ENEMY.hp }} / {{ state.players.ENEMY.hp_max }}</span>
              <span v-if="energyOn" class="bt-energy" title="上场卡牌要消耗能量, 每次轮到行动时补充">
                能量 {{ state.players.ENEMY.energy }} / {{ energyMaxOf('ENEMY') }}
              </span>
              <span class="bt-spacer" />
              <button
                class="bt-btn small"
                type="button"
                :disabled="!canAct('ENEMY') || actionBusy || state.active !== 'ENEMY'"
                :title="state.active !== 'ENEMY' ? '现在不是敌方的行动' : '结束敌方的行动, 交给对手'"
                @click="endTurn('ENEMY')"
              >
                结束行动
              </button>
            </div>
          </section>

          <!-- 回合指示 (key 随回合/行动方变化 → 重新创建元素以重放动画) -->
          <div :key="`${state.turn}-${state.active}`" class="bt-turnbar">
            <span>回合 {{ state.turn }}</span>
            <span class="bt-turn-owner" :class="state.active === 'PLAYER' ? 'mine' : 'theirs'">
              {{ state.active === 'PLAYER' ? '我方行动' : '敌方行动' }}
            </span>
            <span v-if="state.finished" class="bt-result">
              {{ state.winner ? `${state.winner === 'PLAYER' ? '我方' : '敌方'}获胜` : '平局' }}
            </span>
          </div>

          <!-- 我方 -->
          <section class="bt-side" :class="{ active: state.active === 'PLAYER' }">
            <div
              :key="`panel-PLAYER-${sideSerial('PLAYER')}`"
              class="bt-player"
              :class="{
                targetable: isPanelTargetable('PLAYER'),
                'is-hurt': sideKind('PLAYER') === 'hit',
                'is-heal': sideKind('PLAYER') === 'heal',
              }"
              @click="onPanelClick('PLAYER')"
              @dragover.prevent
              @drop.prevent="onPanelDrop('PLAYER')"
            >
              <span v-if="sideText('PLAYER')" class="bt-float">{{ sideText('PLAYER') }}</span>
              <span class="bt-side-name">我方</span>
              <span class="bt-hp">HP {{ state.players.PLAYER.hp }} / {{ state.players.PLAYER.hp_max }}</span>
              <span v-if="energyOn" class="bt-energy" title="上场卡牌要消耗能量, 每次轮到行动时补充">
                能量 {{ state.players.PLAYER.energy }} / {{ energyMaxOf('PLAYER') }}
              </span>
              <span class="bt-spacer" />
              <button
                class="bt-btn small"
                type="button"
                :disabled="!canAct('PLAYER') || actionBusy || state.active !== 'PLAYER'"
                :title="state.active !== 'PLAYER' ? '现在不是我方的行动' : '结束我方的行动, 交给对手'"
                @click="endTurn('PLAYER')"
              >
                结束行动
              </button>
            </div>

            <div class="bt-zone field">
              <div class="bt-zone-head">
                <span class="bt-zone-name">场上</span>
                <span class="bt-zone-meta">{{ fieldCount('PLAYER') }} / {{ fieldSize }}</span>
              </div>
              <div class="bt-field" @dragover.prevent @drop.prevent="onFieldDrop('PLAYER', $event)">
                <div
                  v-for="(slot, index) in fieldSlots('PLAYER')"
                  :key="`p${index}`"
                  class="bt-slot"
                  :class="{ empty: !slot, 'drop-hint': canDropOnSlot('PLAYER', index) }"
                  @dragover.prevent
                  @drop.prevent="onSlotDrop('PLAYER', index, $event)"
                  @click="onSlotClick('PLAYER', index)"
                >
                  <div
                    v-if="slot"
                    class="bt-card-wrap"
                    :class="{ ghost: isGhostCard(slot) }"
                    :draggable="draggableCard(slot)"
                    @dragstart="onDragStart(slot, $event)"
                    @dragend="onDragEnd"
                    @click.stop="onCardClick(slot)"
                    @contextmenu.prevent="inspectCard(slot)"
                  >
                    <BattleCard
                      :card="slot"
                      :statuses="statusList(slot)"
                      :selected="selectionCardId === slot.id"
                      :targetable="isTargetable(slot)"
                      :inactive="!canOperate(slot.controller)"
                      :ready="readyIds.has(slot.id)"
                      :fx-kind="fxKindOf(slot.id)"
                      :fx-serial="fxSerialOf(slot.id)"
                      :fx-text="fxTextOf(slot.id)"
                    />
                  </div>
                  <span v-else class="bt-slot-empty">{{ index + 1 }}</span>
                </div>
              </div>
            </div>

            <div class="bt-zone hand">
              <div class="bt-zone-head">
                <span class="bt-zone-name">手牌</span>
                <span class="bt-zone-meta">{{ state.players.PLAYER.hand.length }} 张</span>
              </div>
              <div class="bt-hand">
                <div
                  v-for="card in handCards('PLAYER')"
                  :key="card.id"
                  class="bt-card-wrap hand"
                  :class="{ unaffordable: !playableHandCard(card) }"
                  :title="blockReasonOf(card)"
                  :draggable="draggableCard(card)"
                  @dragstart="onDragStart(card, $event)"
                  @dragend="onDragEnd"
                  @click.stop="onCardClick(card)"
                  @contextmenu.prevent="inspectCard(card)"
                >
                  <BattleCard
                    :card="card"
                    :statuses="statusList(card)"
                    :selected="selectionCardId === card.id"
                    :inactive="!canOperate(card.controller) || !playableHandCard(card)"
                    :ready="readyIds.has(card.id)"
                    :fx-kind="fxKindOf(card.id)"
                    :fx-serial="fxSerialOf(card.id)"
                    :fx-text="fxTextOf(card.id)"
                  />
                  <span v-if="costOf(card) > 0" class="bt-cost" :title="`上场需要 ${costOf(card)} 点能量`">
                    {{ costOf(card) }}
                  </span>
                </div>
                <span v-if="handCards('PLAYER').length === 0" class="bt-empty">我方没有手牌</span>
              </div>
            </div>

            <div class="bt-piles">
              <button class="bt-pile deck" type="button" title="查看我方牌库" @click="openPile('PLAYER', 'DECK')">
                <span class="bt-pile-label">牌库</span><b>{{ state.players.PLAYER.deck.length }}</b>
              </button>
              <button
                :key="`grave-PLAYER-${gravePulse.PLAYER ?? 0}`"
                class="bt-pile grave"
                :class="{ 'is-pulse': Boolean(gravePulse.PLAYER) }"
                type="button"
                @click="openPile('PLAYER', 'GRAVEYARD')"
              >
                <span class="bt-pile-label">墓地</span><b>{{ state.players.PLAYER.graveyard.length }}</b>
              </button>
              <button
                v-if="state.players.PLAYER.banished.length"
                class="bt-pile gone"
                type="button"
                @click="openPile('PLAYER', 'BANISHED')"
              >
                <span class="bt-pile-label">除外</span><b>{{ state.players.PLAYER.banished.length }}</b>
              </button>
            </div>
          </section>
        </div>

        <!-- 操作栏 -->
        <footer class="bt-actionbar">
          <template v-if="currentSelection">
            <span class="bt-hint">{{ selectionHint }}</span>
            <button
              v-if="currentSelection.zone === 'FIELD'"
              class="bt-btn small"
              type="button"
              :class="{ primary: currentSelection.effect_id === null }"
              @click="selectEffect(null)"
            >
              普通攻击
            </button>
            <button
              v-for="skill in selectionSkills"
              :key="skill.effect_id"
              class="bt-btn small"
              type="button"
              :class="{ primary: currentSelection.effect_id === skill.effect_id }"
              @click="selectEffect(skill.effect_id)"
            >
              {{ skill.label }}
            </button>
            <button
              v-if="currentSelection.effect_id"
              class="bt-btn small primary"
              type="button"
              @click="activateSelected"
            >
              发动技能
            </button>
            <button class="bt-btn small" type="button" @click="clearSelection">取消</button>
            <button class="bt-btn small" type="button" title="查看这张卡的完整资料" @click="inspectSelected">
              详情
            </button>
            <button
              v-if="practice && currentSelection.zone === 'FIELD'"
              class="bt-btn small"
              type="button"
              title="把这张卡收回牌库"
              @click="returnSelectedToDeck"
            >
              下场
            </button>
          </template>
          <template v-else>
            <span class="bt-hint">
              {{
                dragEnabled
                  ? '拖动自己的卡牌到目标上执行操作, 或点击卡牌后再点目标; 右键查看详情'
                  : '点击自己的卡牌 → 选择动作 → 点击目标; 右键查看详情'
              }}
            </span>
          </template>

          <span class="bt-spacer" />

          <button
            v-if="waitingForAI"
            class="bt-btn small primary"
            type="button"
            :disabled="aiBusy || playing"
            @click="askAI"
          >
            {{ aiBusy ? '生成中…' : '让 AI 行动' }}
          </button>
          <button v-if="practice" class="bt-btn small" type="button" @click="resetPractice">重置演习</button>
          <button
            class="bt-btn small"
            type="button"
            :disabled="sessionSteps.length === 0"
            :title="sessionSteps.length === 0 ? '还没有可回退的操作' : '查看每一步操作, 并回退到任意一步之前'"
            @click="showReplay = true"
          >
            回溯<span v-if="sessionSteps.length" class="bt-count">{{ sessionSteps.length }}</span>
          </button>
          <button class="bt-btn small" type="button" @click="leaveSession">
            {{ practice ? '退出演习' : '结束战斗' }}
          </button>
        </footer>
      </template>

      <!-- 弹窗层: 卡牌详情 / 牌堆查看 / 战斗日志 -->
      <CardDetail
        v-if="detailCard && state"
        :card="detailCard"
        :state="state!"
        :description="detailDescription"
        :practice="practice"
        :field-full="detailFieldFull"
        @close="closeDetail"
        @play="detailPlay"
        @return="detailReturn"
      />

      <!-- 询问层: 引擎挂出来的待回答询问 / 操作前先确认要发动的技能 -->
      <div v-if="dialog" class="bt-ask-mask" @click.self="dismissDialog">
        <div class="bt-ask-modal">
          <h3 class="bt-ask-title">{{ dialogTitle }}</h3>
          <p v-if="dialogDetail" class="bt-ask-detail">{{ dialogDetail }}</p>
          <div class="bt-ask-options">
            <label
              v-for="option in dialogOptions"
              :key="option.id"
              class="bt-ask-option"
              :class="{ picked: dialogPicked.includes(option.id) }"
            >
              <input
                type="checkbox"
                :checked="dialogPicked.includes(option.id)"
                @change="toggleDialogOption(option.id)"
              />
              <span>{{ option.label }}</span>
            </label>
          </div>
          <div class="bt-ask-foot">
            <span v-if="dialog?.type === 'ask'" class="bt-ask-count">
              已选 {{ dialogPicked.length }} 张 · 需要 {{ dialogSpread.min }}-{{ dialogSpread.max }} 张
            </span>
            <span class="bt-spacer" />
            <button class="bt-btn small" type="button" :disabled="actionBusy" @click="submitDialogFallback">
              {{ dialogKind === 'DISCARD' ? '交给引擎自动弃牌' : '都不发动' }}
            </button>
            <button
              class="bt-btn small primary"
              type="button"
              :disabled="actionBusy || !dialogReady"
              @click="submitDialog"
            >
              确定
            </button>
          </div>
        </div>
      </div>
      <PileViewer
        v-if="pileView && pileMeta"
        :side-label="pileMeta.sideLabel"
        :zone-label="pileMeta.zoneLabel"
        :cards="pileCards"
        :practice="practice"
        :allow-play="pileAllowPlay"
        :empty-text="pileMeta.emptyText"
        @close="pileView = null"
        @inspect="inspectCard"
        @play="playFromPile"
      />
      <LogViewer v-if="showLogs" :items="logItems" @close="showLogs = false" />
      <ReplayViewer
        v-if="showReplay"
        :steps="sessionSteps"
        :report="replayReport"
        :dropped="sessionDropped"
        :can-rewind="mode === 'BATTLE'"
        @close="showReplay = false"
        @rewind="onRewind"
      />
      <DebugViewer
        v-if="showDebug && debugInfo"
        :info="debugInfo"
        :worldbook="worldbookStatus"
        :reply-limit="debugReplyLimit"
        @update:reply-limit="debugReplyLimit = $event"
        @close="showDebug = false"
      />

      <!-- 浮动提示层: 不参与布局, 所以提示 / 播放条出现时卡牌位置一动不动 -->
      <div class="bt-floats" :class="{ 'is-battle': Boolean(state) }">
        <div v-if="currentFrame" class="bt-float play">
          <span class="bt-play-label">{{ playbackTitle }}</span>
          <span class="bt-play-step">
            {{ playbackIndex + 1 }} / {{ playback?.帧.length }}：{{ currentFrame.说明 }}
          </span>
          <button class="bt-btn small" type="button" @click="stopPlayback">跳过</button>
        </div>
        <div v-if="worldbookWarning" class="bt-float warn">
          <span class="bt-float-text">{{ worldbookWarning }}</span>
          <button class="bt-btn small" type="button" @click="refreshWorldbook">重新检测</button>
        </div>
        <div v-for="notice in notices" :key="notice.id" class="bt-float" :class="notice.level">
          <span class="bt-float-text">{{ notice.text }}</span>
          <button
            class="bt-float-close"
            type="button"
            title="关掉这条提示"
            @click="dismissNoticeById(notice.id)"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { loadDecks, loadDeployedDeck, resolveDeck } from '../卡组/data.ts';
import type { Deck } from '../卡组/schema.ts';
import {
  battleConfig,
  canPayEnergy,
  canPlayCard,
  cardCostFor,
  energyEnabled,
  energyMaxFor,
  isGuardBlocked,
  listActivatable,
  type ActivatableEffect,
} from '../引擎/battle.ts';
import {
  otherPlayer,
  type AskKind,
  type AskRequest,
  type BattleState,
  type CardInstance,
  type EffectTiming,
  type PlayerId,
} from '../引擎/types.ts';
import NumberField from '../共用/NumberField.vue';
import PanelLookSettings from '../共用/PanelLookSettings.vue';
import {
  flushPanelLookSave,
  loadPanelLook,
  onPanelLookChanged,
  panelLookStyle,
  type PanelLook,
} from '../共用/外观';
import {
  dismissNotice,
  noticeDuration,
  pushNotice,
  type Notice,
  type NoticeLevel,
} from '../共用/浮动提示.ts';
import BattleCard, { type BattleCardStatus } from './components/BattleCard.vue';
import CardDetail from './components/CardDetail.vue';
import DebugViewer from './components/DebugViewer.vue';
import LogViewer from './components/LogViewer.vue';
import PileViewer from './components/PileViewer.vue';
import ReplayViewer from './components/ReplayViewer.vue';
import { collectBattleLogs } from './日志.ts';
import { cardAuraNames } from './详情.ts';
import { SETTLE_TITLE, type BattlePlayback, type PlaybackFrame } from './播放.ts';
import {
  DEFAULT_ACTION_INTERVAL,
  DEFAULT_SETTLE_INTERVAL,
  MAX_BATTLE_INTERVAL,
  describeBattlePace,
  flushBattlePaceSave,
  loadBattlePace,
  onBattlePaceChanged,
  saveBattlePace,
  type BattlePace,
} from './节奏.ts';
import { DEBUG_REPLY_LIMIT_DEFAULT, collectBattleDebug, collectDebugReplies } from './调试.ts';
import type { BattleSetup } from './schema.ts';
import {
  battleWorldbookStatus,
  endBattleSession,
  getBattleState,
  getSessionMode,
  isBattleWaitingForAI,
  isControllingBothSides,
  listSideAskable,
  listSideAsks,
  operateActivate,
  operateAttack,
  operateEndTurn,
  operatePlay,
  operateResolveAsk,
  onBattlePlayback,
  requestAIDecision,
  resetPracticeSession,
  setControlBothSides,
  setPracticeEnergyEnabled,
  startBattleSession,
  startPracticeSession,
  type BattleMode,
  canOperate,
  canViewPile,
  getCardDefinition,
  getDecisionLog,
  getLastDecisionResult,
  getSessionOps,
  getSessionDropped,
  getSessionSteps,
  battleReplayReport,
  rewindToStep,
  practicePlayFromDeck,
  practiceReturnToDeck,
  readBattleStore,
} from './同步.ts';
import type { BattleWorldbookStatus } from './世界书.ts';

const CLOSE_EVENT = 'card-battle-close';
const NARROW_MAX_WIDTH = 900;

/** 当前选中的卡 + 选中的动作 (effect_id 为 null 表示普通攻击 / 上场) */
interface Selection {
  side: PlayerId;
  card_id: string;
  zone: 'HAND' | 'FIELD';
  effect_id: string | null;
}

// ---------------------------------------------------------------------------
// 基础状态
// ---------------------------------------------------------------------------

const tick = ref(0);
const showSettings = ref(false);
const showLook = ref(false);
const showLogs = ref(false);
const showDebug = ref(false);
const showReplay = ref(false);
/** 调试弹窗显示多少条 AI 回复 */
const debugReplyLimit = ref(DEBUG_REPLY_LIMIT_DEFAULT);
/**
 * 浮动提示 (规则见 共用/浮动提示.ts).
 *
 * 提示条不能挤进正常流里: 面板是一整块高度定死的板子, 塞一条横幅进去内容区就被压小,
 * 卡牌跟着上下跳 —— 所以提示一律浮在面板上层, 条数 / 寿命由提示模块管.
 */
const notices = ref<Notice[]>([]);
const isNarrow = ref(false);
const dragEnabled = ref(true);
const bothSides = ref(false);
const aiBusy = ref(false);
/** 一次只允许一个操作在跑 (避免连点结束行动 / 上场排队堆叠) */
const actionBusy = ref(false);
const selection = ref<Selection | null>(null);
const worldbookStatus = ref<BattleWorldbookStatus | null>(null);
/** 正在播的内容 (AI 操作回放 / 回合结算); null = 直接看最终局面 */
const playback = ref<BattlePlayback | null>(null);
/** 播到第几帧 (下标) */
const playbackIndex = ref(0);
/** 播放节奏 (与其它面板共享的一份设置) */
const pace = ref<BattlePace>(loadBattlePace());

/** 正在查看详情的卡 (卡牌实例 id; 空串 = 没打开) */
const detailCardId = ref('');

/** 正在查看的牌堆 (演习模式两边都能看, 正式战斗只看自己的) */
interface PileView {
  side: PlayerId;
  zone: 'DECK' | 'GRAVEYARD' | 'BANISHED';
}
const pileView = ref<PileView | null>(null);

// ---- 浮动提示 ----

/** 提示序号 (自增, 当 key 与「关哪一条」的凭据) */
let notice_seq = 0;
/** 信息类提示的自动消失计时 (id → timer) */
const noticeTimers = new Map<number, number>();

/** 把多余的计算器收掉 (被挤掉的提示不该再定时消失) */
function syncNoticeTimers() {
  const alive = new Set(notices.value.map(item => item.id));
  for (const [id, timer] of noticeTimers) {
    if (!alive.has(id)) {
      viewportWindow.clearTimeout(timer);
      noticeTimers.delete(id);
    }
  }
}

/** 关掉一条提示 (点 ✕ 或到点自动消失都走这里) */
function dismissNoticeById(id: number) {
  notices.value = dismissNotice(notices.value, id);
  syncNoticeTimers();
}

/**
 * 弹一条提示.
 *
 * 信息类 4 秒后自己消失; 错误类留着等手动关 —— 两档的判定标准见 共用/浮动提示.ts 顶部.
 */
function showNotice(text: string, level: NoticeLevel = 'info') {
  notice_seq += 1;
  const id = notice_seq;
  notices.value = pushNotice(notices.value, { id, level, text });
  const ms = noticeDuration(level);
  if (ms > 0) {
    noticeTimers.set(
      id,
      viewportWindow.setTimeout(() => dismissNoticeById(id), ms),
    );
  }
  syncNoticeTimers();
}

/** 只是确认一下的提示 (本轮已攻击过 / 还没轮到你, 4 秒后自己消失) */
function noticeInfo(text: string) {
  showNotice(text, 'info');
}

/** 出岔子或「点了没反应看不出原因」的提示 (留着等手动关) */
function noticeError(text: string) {
  showNotice(text, 'error');
}

/** 强制重算: 引擎状态是普通对象, 变更后靠它驱动视图刷新 */
function refresh() {
  tick.value += 1;
  // 顺便和上一份快照对一下, 把这一轮发生的事播成动画
  syncFx();
}

/**
 * 跑一个异步操作.
 *
 * 两个必须做到的事:
 * - 同一时刻只跑一个 (连点「结束行动」不会把好几次行动排成一队);
 * - 无论成功、失败还是抛错, 都要 refresh(), 否则状态已经变了界面却停在旧样子.
 */
async function runAction(action: () => Promise<boolean>): Promise<boolean> {
  // 播放中看到的是「过去」的局面, 这时候不能动
  if (actionBusy.value || playing.value) {
    return false;
  }
  actionBusy.value = true;
  try {
    return await action();
  } catch (error) {
    // 抛错是最难看懂的一类失败 (点了没反应, 或者提示条一闪而过), 所以算错误
    noticeError(`操作失败: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    actionBusy.value = false;
    refresh();
  }
}

// ---- 垫底外观 (与卡牌库/卡组共享同一份设置) ----
const look = ref<PanelLook>(loadPanelLook());
const lookStyle = computed(() => panelLookStyle(look.value));
const off_look = onPanelLookChanged(() => {
  look.value = loadPanelLook();
});

// ---- 播放 (AI 操作回放 / 回合结算) ----
//
// 玩法侧的一步操作在引擎里是一串日志, 打完之后变量里只有最终局面.
// 同步层顺手把中间那几帧录了下来 (`onBattlePlayback` 送过来), 这里就负责按顺序演出来:
// 每帧停多久看设置, 播完自动回到最终局面. 播放中锁操作 —— 界面看到的是「过去」,
// 这时候点按钮会跟真实局面打架.

/** 播放中显示的那一帧 (没有在播就是 null) */
const currentFrame = computed<PlaybackFrame | null>(() => {
  const active = playback.value;
  return active ? (active.帧[playbackIndex.value] ?? null) : null;
});

/** 播放中 (或者说锁操作中) */
const playing = computed(() => playback.value !== null);

/** 进度条上的标题: 走到结算帧就改口叫「回合结算」 */
const playbackTitle = computed(() => {
  const frame = currentFrame.value;
  if (!frame) {
    return '';
  }
  return frame.种类 === '结算' ? SETTLE_TITLE : playback.value?.标题 ?? '';
});

const playbackHint = computed(() => describeBattlePace(pace.value));

let playbackTimer: number | null = null;

/** 这一帧该停多久 (0 = 这一档不播) */
function frameInterval(frame: PlaybackFrame): number {
  return frame.种类 === '结算' ? pace.value.结算间隔 : pace.value.操作间隔;
}

function clearPlaybackTimer() {
  if (playbackTimer !== null) {
    viewportWindow.clearTimeout(playbackTimer);
    playbackTimer = null;
  }
}

function armPlaybackTimer() {
  clearPlaybackTimer();
  const frame = currentFrame.value;
  if (!frame) {
    return;
  }
  playbackTimer = viewportWindow.setTimeout(advancePlayback, Math.max(0, frameInterval(frame)));
}

/** 播下一帧; 到底了就回到最终局面 */
function advancePlayback() {
  const active = playback.value;
  if (!active) {
    return;
  }
  if (playbackIndex.value + 1 >= active.帧.length) {
    stopPlayback();
    return;
  }
  playbackIndex.value += 1;
  armPlaybackTimer();
  refresh();
}

/** 停下播放 (跳过按钮 / 播完 / 关面板都走这里) */
function stopPlayback() {
  clearPlaybackTimer();
  playback.value = null;
  playbackIndex.value = 0;
  refresh();
}

/** 播放中要干别的事 (回退 / 重开 / 结束战斗) 时先收场: 停下播放回到真局面 */
function cancelPlayback() {
  if (playing.value) {
    stopPlayback();
  }
}

/** 收到新录好的播放内容 (同步送来, 免得最终局面先闪一下) */
function beginPlayback(next: BattlePlayback) {
  clearPlaybackTimer();
  // 间隔设成 0 的那一档不播
  const 帧 = next.帧.filter(frame => frameInterval(frame) > 0);
  if (帧.length === 0) {
    playback.value = null;
    playbackIndex.value = 0;
    refresh();
    return;
  }
  playback.value = { 标题: next.标题, 帧 };
  playbackIndex.value = 0;
  armPlaybackTimer();
  refresh();
}

/** 设置区里的两个输入框 (改完立刻生效并落存) */
const paceAction = computed({
  get: () => pace.value.操作间隔,
  set: value => {
    pace.value = saveBattlePace({ 操作间隔: value });
  },
});
const paceSettle = computed({
  get: () => pace.value.结算间隔,
  set: value => {
    pace.value = saveBattlePace({ 结算间隔: value });
  },
});
const off_pace = onBattlePaceChanged(() => {
  pace.value = loadBattlePace();
});

/** 真局面里的这一边能不能操作 (播放中一律算不能) */
function canAct(side: PlayerId): boolean {
  return !playing.value && canOperate(side);
}

const state = computed<BattleState | null>(() => {
  void tick.value;
  // 播放中给人看的是录下来的那一帧, 不是变量里的最终局面
  return currentFrame.value?.状态 ?? getBattleState();
});
const mode = computed<BattleMode | null>(() => {
  void tick.value;
  return getSessionMode();
});
const practice = computed(() => mode.value === 'PRACTICE');
const waitingForAI = computed(() => {
  void tick.value;
  return isBattleWaitingForAI();
});
const modeLabel = computed(() => {
  if (practice.value) return '演习';
  if (state.value?.finished) return '已结束';
  return state.value ? '战斗中' : '';
});
const fieldSize = computed(() => {
  const current = state.value;
  return current ? (battleConfig(current)?.field_size ?? 5) : 5;
});
const worldbookWarning = computed(() => {
  const status = worldbookStatus.value;
  if (!status || status.已安装) {
    return status && !status.最新 ? '世界书条目是旧版本, 请重新导入 世界书-卡牌战斗.json' : '';
  }
  return '未检测到世界书条目「[战斗]敌方回合决策」, AI 收不到决策提示; 请手动导入 世界书-卡牌战斗.json';
});

// ---------------------------------------------------------------------------
// 能量 · 询问
// ---------------------------------------------------------------------------

/** 这场战斗有没有开能量机制 (关掉时两侧上限都是 0, 界面就不显示这一栏) */
const energyOn = computed(() => {
  const current = state.value;
  return Boolean(current && energyEnabled(current));
});

/** 某一方的能量上限 (还没轮到的一方读它自己的记录是 0, 改用曲线算) */
function energyMaxOf(side: PlayerId): number {
  const current = state.value;
  if (!current) {
    return 0;
  }
  const record = current.players[side];
  return record.energy_max > 0 ? record.energy_max : energyMaxFor(current, current.turn);
}

/** 这张手牌此刻上场所需的能量 (含洗牌加价; 0 = 免费, 不显示角标) */
function costOf(card: CardInstance): number {
  const current = state.value;
  return current ? cardCostFor(current, card) : 0;
}

/** 这张手牌此刻能不能上场 (缺能量 / 场上满都算不能) */
function playableHandCard(card: CardInstance): boolean {
  const current = state.value;
  return Boolean(current && canPlayCard(current, card.id));
}

/** 这张手牌为什么不能上场 (空串 = 能上场) */
function blockReasonOf(card: CardInstance): string {
  const current = state.value;
  if (!current || playableHandCard(card)) {
    return '';
  }
  if (!canPayEnergy(current, card)) {
    return `能量不足: 需要 ${costOf(card)}, 只剩 ${current.players[card.controller].energy}`;
  }
  return fieldCount(card.controller) >= fieldSize.value ? '场上已满' : '现在不能上场';
}

/** 操作前会先问一句的技能涉及的时点 */
const ATTACK_TIMINGS: EffectTiming[] = ['BEFORE_ATTACK', 'BEFORE_DAMAGE', 'AFTER_DAMAGE', 'AFTER_ATTACK'];
const END_TIMINGS: EffectTiming[] = ['SIDE_END', 'TURN_END'];

/** 确认框里的一项 (就是「要不要发动这个技能」) */
interface DialogOption {
  id: string;
  label: string;
  /** 不勾选时不发动; 缺省表示「勾上」(与引擎的 ask_default 一致) */
  default_run?: boolean;
}

/** 界面上的弹窗: 回答引擎的询问, 或操作前先确认要发动的技能 */
type Dialog =
  | { type: 'ask'; side: PlayerId; ask: AskRequest }
  | {
      type: 'confirm';
      side: PlayerId;
      title: string;
      detail: string;
      options: DialogOption[];
      /** 确认后执行的操作 (勾中的技能作为 answers 传回去) */
      run: (answers: string[]) => Promise<boolean>;
    };

const dialog = ref<Dialog | null>(null);
const dialogPicked = ref<string[]>([]);

const dialogTitle = computed(() =>
  dialog.value?.type === 'ask' ? dialog.value.ask.title : (dialog.value?.title ?? ''),
);
const dialogDetail = computed(() =>
  dialog.value?.type === 'ask' ? dialog.value.ask.detail : (dialog.value?.detail ?? ''),
);
const dialogOptions = computed<DialogOption[]>(() => {
  const current = dialog.value;
  if (!current) {
    return [];
  }
  return current.type === 'ask'
    ? current.ask.options.map(option => ({ id: option.id, label: option.label }))
    : current.options;
});
const dialogSpread = computed(() => {
  const current = dialog.value;
  if (!current) {
    return { min: 0, max: 0 };
  }
  return current.type === 'ask' ? { min: current.ask.min, max: current.ask.max } : { min: 0, max: current.options.length };
});
const dialogReady = computed(() => {
  const { min, max } = dialogSpread.value;
  const count = dialogPicked.value.length;
  return count >= min && count <= max;
});
/** 弃牌类询问才显示「自动弃牌」的说法 */
const dialogKind = computed<AskKind | null>(() => (dialog.value?.type === 'ask' ? dialog.value.ask.kind : null));

function toggleDialogOption(id: string) {
  const picked = dialogPicked.value;
  const index = picked.indexOf(id);
  if (index >= 0) {
    picked.splice(index, 1);
  } else {
    picked.push(id);
  }
  // 最多只能选 N 张的询问: 超了就顶掉最早选的那张, 免得玩家反复点却不知道为什么不生效
  const { max } = dialogSpread.value;
  while (dialogPicked.value.length > max) {
    dialogPicked.value.shift();
  }
}

/** 默认勾选: 按卡上写的 ask_default (省略 = 勾上) */
function defaultPicked(options: DialogOption[]): string[] {
  return options.filter(option => option.default_run !== false).map(option => option.id);
}

/** 引擎挂出来的待回答询问 (只有此刻能操作的那一方才弹) */
const pendingAsk = computed<{ side: PlayerId; ask: AskRequest } | null>(() => {
  void tick.value;
  const current = state.value;
  if (!current || current.finished) {
    return null;
  }
  // 操作前的确认框正开着时不抢焦点, 关掉之后这条询问会自己弹出来
  if (dialog.value?.type === 'confirm') {
    return null;
  }
  for (const side of ['PLAYER', 'ENEMY'] as PlayerId[]) {
    if (!canAct(side)) {
      continue;
    }
    const ask = listSideAsks(side)[0];
    if (ask) {
      return { side, ask };
    }
  }
  return null;
});

watch(
  pendingAsk,
  next => {
    if (!next) {
      if (dialog.value?.type === 'ask') {
        dialog.value = null;
      }
      return;
    }
    const opened = dialog.value;
    if (opened?.type === 'ask' && opened.ask.id === next.ask.id) {
      return;
    }
    dialog.value = { type: 'ask', side: next.side, ask: next.ask };
    dialogPicked.value = [];
  },
  { immediate: true },
);

async function submitDialog() {
  const current = dialog.value;
  if (!current || !dialogReady.value) {
    return;
  }
  const picked = dialogPicked.value.slice();
  if (current.type === 'ask') {
    await runAction(() => operateResolveAsk(current.side, current.ask.id, picked));
  } else {
    await runAction(() => current.run(picked));
  }
  if (dialog.value === current) {
    dialog.value = null;
  }
  dialogPicked.value = [];
}

/** 「不选 / 不发动」: 让引擎按它自己算好的默认答案收尾 */
async function submitDialogFallback() {
  const current = dialog.value;
  if (!current) {
    return;
  }
  if (current.type === 'ask') {
    await runAction(() => operateResolveAsk(current.side, current.ask.id, current.ask.fallback));
  } else {
    await runAction(() => current.run([]));
  }
  if (dialog.value === current) {
    dialog.value = null;
  }
  dialogPicked.value = [];
}

/** 点空白处 / 取消: 确认框就是「不做了」, 引擎的询问不能这样丢掉 (得回答或交给引擎) */
function dismissDialog() {
  if (dialog.value?.type === 'confirm') {
    dialog.value = null;
    dialogPicked.value = [];
  }
}

// ---------------------------------------------------------------------------
// 卡片视图
// ---------------------------------------------------------------------------

/** 场上卡牌数量 (区域标题用) */
function fieldCount(side: PlayerId): number {
  return state.value?.players[side].field.length ?? 0;
}

function fieldSlots(side: PlayerId): (CardInstance | null)[] {
  void tick.value;
  const current = state.value;
  const size = fieldSize.value;
  const slots: (CardInstance | null)[] = Array.from({ length: size }, () => null);
  if (!current) {
    return slots;
  }
  for (const id of current.players[side].field) {
    const card = current.cards[id];
    if (card && card.slot !== null && card.slot >= 0 && card.slot < size) {
      slots[card.slot] = card;
    }
  }
  // 刚倒下的卡 (ghosts) 还在原地多停一会儿, 好让「倒下」的动画看得见
  for (const ghost of ghosts.value) {
    if (ghost.side !== side || ghost.slot < 0 || ghost.slot >= size || slots[ghost.slot]) {
      continue;
    }
    const card = current.cards[ghost.card_id];
    if (card) {
      slots[ghost.slot] = card;
    }
  }
  return slots;
}

/** 这张卡现在能不能拖 (刚倒下的幽灵卡不能) */
function draggableCard(card: CardInstance): boolean {
  return dragEnabled.value && (card.zone === 'FIELD' || card.zone === 'HAND') && canAct(card.controller);
}

/** 这个格子是不是真的空着 (幽灵卡不算占) */
function slotEmpty(side: PlayerId, index: number): boolean {
  void tick.value;
  const current = state.value;
  if (!current) {
    return false;
  }
  return !current.players[side].field.some(id => current.cards[id]?.slot === index);
}

/** 第一个真正空着的格子 (找不到返回 -1) */
function firstEmptySlot(side: PlayerId): number {
  for (let index = 0; index < fieldSize.value; index += 1) {
    if (slotEmpty(side, index)) {
      return index;
    }
  }
  return -1;
}

function handCards(side: PlayerId): CardInstance[] {
  const current = state.value;
  if (!current) {
    return [];
  }
  return current.players[side].hand.map(id => current.cards[id]).filter(Boolean);
}

function statusList(card: CardInstance): BattleCardStatus[] {
  const current = state.value;
  if (!current) {
    return [];
  }
  return card.statuses
    .map(id => current.statuses[id])
    .filter(Boolean)
    .map(status => ({
      name: status.name,
      stacks: status.stacks,
      remaining: status.expiry ? status.expiry.remaining : null,
    }));
}

/** 该方手牌是否对玩家可见 */
function showHand(side: PlayerId): boolean {
  return side === 'PLAYER' || practice.value || bothSides.value;
}

// ---------------------------------------------------------------------------
// 卡牌详情 / 牌堆查看 / 日志
// ---------------------------------------------------------------------------

/** 正在查看详情的卡 (卡被移出战斗后自动关闭) */
const detailCard = computed<CardInstance | null>(() => {
  void tick.value;
  if (!detailCardId.value) {
    return null;
  }
  return state.value?.cards[detailCardId.value] ?? null;
});

/** 卡牌库里的自然语言描述 */
const detailDescription = computed(() => {
  const card = detailCard.value;
  return card ? (getCardDefinition(card.id)?.description ?? '') : '';
});

/** 详情弹窗里的「上场」是否可用 (该方场上是否还有空位) */
const detailFieldFull = computed(() => {
  const card = detailCard.value;
  return card ? fieldCount(card.controller) >= fieldSize.value : false;
});

/** 正在查看的牌堆里的卡 (按牌堆顺序) */
const pileCards = computed<CardInstance[]>(() => {
  void tick.value;
  const view = pileView.value;
  const current = state.value;
  if (!view || !current) {
    return [];
  }
  const player = current.players[view.side];
  const ids = view.zone === 'DECK' ? player.deck : view.zone === 'GRAVEYARD' ? player.graveyard : player.banished;
  return ids.map(id => current.cards[id]).filter(Boolean);
});

/** 牌堆弹窗的标题文案 */
const pileMeta = computed(() => {
  const view = pileView.value;
  if (!view) {
    return null;
  }
  const side_label = view.side === 'PLAYER' ? '我方' : '敌方';
  const zone_label = view.zone === 'DECK' ? '牌库' : view.zone === 'GRAVEYARD' ? '墓地' : '除外';
  return { sideLabel: side_label, zoneLabel: zone_label, emptyText: `${side_label}${zone_label}里没有卡牌。` };
});

/** 牌堆弹窗里的「上场」是否可用 (演习 + 该方场上有空位) */
const pileAllowPlay = computed(
  () => practice.value && Boolean(pileView.value) && fieldCount(pileView.value?.side ?? 'PLAYER') < fieldSize.value,
);

/** 汇总的日志列表 (操作记录 + 引擎日志 + AI 决策) */
const logItems = computed(() => {
  void tick.value;
  return collectBattleLogs({
    ops: getSessionOps(),
    log: state.value?.log ?? [],
    ai: getLastDecisionResult(),
    decisions: getDecisionLog(),
    aiTurn: state.value?.turn ?? 0,
  });
});
const logCount = computed(() => logItems.value.length);

/**
 * 调试弹窗的数据: 面板发给 AI 的注入文本 + AI 的回复 + 变量快照.
 *
 * 没打开弹窗时不计算 —— 变量 JSON 可能很长, 没必要每秒序列化一次.
 */
const debugInfo = computed(() => {
  if (!showDebug.value) {
    return null;
  }
  void tick.value;
  return collectBattleDebug({
    store: readBattleStore(),
    replies: collectDebugReplies(debugReplyLimit.value),
    decisions: getDecisionLog(),
    ops: getSessionOps(),
    practice: practice.value,
    replay: battleReplayReport(),
  });
});

/** 回溯弹窗里的步骤 (旧 → 新) */
const sessionSteps = computed(() => {
  void tick.value;
  return getSessionSteps();
});

/** 起点之前已合并掉的步数 (展示用) */
const sessionDropped = computed(() => {
  void tick.value;
  return getSessionDropped();
});

/**
 * 回放体检报告 (只在回溯弹窗打开时算).
 *
 * 它会把整个回放重放一遍与当前局面比对, 所以别常驻计算.
 */
const replayReport = computed(() => {
  if (!showReplay.value) {
    return null;
  }
  void tick.value;
  return battleReplayReport();
});

/** 回溯弹窗点「回到此前」 */
async function onRewind(keep: number) {
  cancelPlayback();
  // 回退会让一整局倒着变一遍, 不作为动画演出来
  muteFx();
  const ok = await runAction(async () => rewindToStep(keep));
  if (!ok) {
    noticeError('回退失败, 战斗保持原样 (详情见控制台).');
  } else {
    showReplay.value = false;
  }
}

function openPile(side: PlayerId, zone: PileView['zone']) {
  if (!canViewPile(side, zone)) {
    noticeInfo('正式战斗看不到敌方的牌库; 演习模式可以随便看。');
    return;
  }
  pileView.value = { side, zone };
}

function inspectCard(card: CardInstance) {
  detailCardId.value = card.id;
}

/** 操作栏的「详情」按钮: 看当前选中的卡 */
function inspectSelected() {
  const card = state.value?.cards[currentSelection.value?.card_id ?? ''];
  if (card) {
    inspectCard(card);
  }
}

function closeDetail() {
  detailCardId.value = '';
}

/** 详情弹窗 / 牌堆弹窗里的「上场」: 手牌走正常上场, 牌堆走演习上场 */
async function playCardToField(card: CardInstance): Promise<boolean> {
  const slot = firstEmptySlot(card.controller);
  const target = slot >= 0 ? slot : undefined;
  const ok = await runAction(async () => {
    const done =
      card.zone === 'HAND'
        ? await operatePlay(card.controller, card.id, target)
        : await practicePlayFromDeck(card.controller, card.id, target);
    if (!done) {
      noticeError('上场失败 (场上可能已满, 或不是演习模式)');
    }
    return done;
  });
  return ok;
}

async function detailPlay() {
  const card = detailCard.value;
  if (card && (await playCardToField(card))) {
    closeDetail();
  }
}

async function detailReturn() {
  const card = detailCard.value;
  if (!card) {
    return;
  }
  const ok = await runAction(async () => {
    const done = await practiceReturnToDeck(card.controller, card.id);
    if (!done) {
      noticeError('下场失败 (只有演习模式能把场上的卡收回牌库)');
    }
    return done;
  });
  if (ok) {
    closeDetail();
  }
}

async function playFromPile(card: CardInstance) {
  await playCardToField(card);
}

/** 操作栏的「下场」按钮: 把选中的场上卡收回牌库 (演习) */
async function returnSelectedToDeck() {
  const sel = currentSelection.value;
  if (!sel) {
    return;
  }
  await runAction(async () => {
    const ok = await practiceReturnToDeck(sel.side, sel.card_id);
    if (!ok) {
      noticeError('下场失败');
    }
    return ok;
  });
  clearSelection();
}

/** Esc 逐层关闭弹窗 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') {
    return;
  }
  if (showReplay.value) {
    showReplay.value = false;
    return;
  }
  if (showDebug.value) {
    showDebug.value = false;
    return;
  }
  if (showLogs.value) {
    showLogs.value = false;
    return;
  }
  if (pileView.value) {
    pileView.value = null;
    return;
  }
  if (detailCard.value) {
    closeDetail();
    return;
  }
  if (currentSelection.value) {
    clearSelection();
  }
}

// ---------------------------------------------------------------------------
// 选择与目标
// ---------------------------------------------------------------------------

const currentSelection = computed<Selection | null>(() => {
  const sel = selection.value;
  const current = state.value;
  if (!sel || !current) {
    return null;
  }
  const card = current.cards[sel.card_id];
  if (!card || card.zone !== sel.zone) {
    return null;
  }
  return sel;
});

const selectionCardId = computed(() => currentSelection.value?.card_id ?? '');
const selectionSkills = computed<ActivatableEffect[]>(() => {
  const sel = currentSelection.value;
  const current = state.value;
  if (!sel || !current) {
    return [];
  }
  return listActivatable(current, sel.side).filter(item => item.card_id === sel.card_id);
});
const selectionHint = computed(() => {
  const sel = currentSelection.value;
  if (!sel) {
    return '';
  }
  if (sel.zone === 'HAND') {
    return sel.effect_id ? '拖动到目标上或点「发动技能」' : '点击我方场上的空位把这张卡放上去';
  }
  if (sel.effect_id) {
    return '拖动到目标上或点「发动技能」';
  }
  return guardBlocksSelection()
    ? '对手场上还有卡, 暂时不能直接打脸 —— 先攻击对手场上的卡'
    : '点击 / 拖动到敌方卡牌或敌方头像上发起攻击';
});

/** 当前选中的卡想打脸会被守卫规则挡下 (提示文案与「头像能否点」共用同一个判断) */
function guardBlocksSelection(): boolean {
  const sel = currentSelection.value;
  const current = state.value;
  if (!sel || sel.zone !== 'FIELD' || sel.effect_id || !current) {
    return false;
  }
  const attacker = current.cards[sel.card_id];
  if (!attacker) {
    return false;
  }
  return isGuardBlocked(current, attacker, otherPlayer(sel.side));
}

/** 这张卡现在能否作为当前选择的合法目标 */
function isTargetable(card: CardInstance): boolean {
  const sel = currentSelection.value;
  // 刚倒下的幽灵卡还挂在格子上, 但它已经不是合法目标了
  if (!sel || sel.zone !== 'FIELD' || card.zone !== 'FIELD') {
    return false;
  }
  if (sel.effect_id) {
    return true;
  }
  return card.controller === otherPlayer(sel.side) && card.zone === 'FIELD';
}

/** 某个玩家头像现在能否作为合法目标 */
function isPanelTargetable(side: PlayerId): boolean {
  const sel = currentSelection.value;
  if (!sel || sel.zone !== 'FIELD') {
    return false;
  }
  if (sel.effect_id) {
    return true;
  }
  // 守卫规则把脸挡住时干脆不让它成为目标, 免得点上去才发现打不了
  return !guardBlocksSelection() && side === otherPlayer(sel.side);
}

/** 手牌能否放到这个空位 */
function canDropOnSlot(side: PlayerId, index: number): boolean {
  const sel = currentSelection.value;
  if (!sel || sel.zone !== 'HAND' || sel.effect_id || sel.side !== side) {
    return false;
  }
  return slotEmpty(side, index);
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

function clearSelection() {
  selection.value = null;
}

function selectEffect(effect_id: string | null) {
  const sel = selection.value;
  if (sel) {
    selection.value = { ...sel, effect_id };
  }
}

function toggleSelection(card: CardInstance) {
  const sel = selection.value;
  if (sel && sel.card_id === card.id) {
    selection.value = null;
    return;
  }
  selection.value = {
    side: card.controller,
    card_id: card.id,
    zone: card.zone === 'HAND' ? 'HAND' : 'FIELD',
    effect_id: null,
  };
}

/** 这一击 / 这一步之前, 有哪些「会先问一句」的技能可以用 (机读区标了 ask 的效果) */
function askableOptions(side: PlayerId, timings: EffectTiming[]): DialogOption[] {
  return listSideAskable(side, timings).map(item => ({
    id: item.effect_id,
    label: item.label,
    default_run: item.default_run,
  }));
}

async function performAttackWith(
  side: PlayerId,
  card_id: string,
  target: string,
  answers?: readonly string[],
): Promise<boolean> {
  const ok = await operateAttack(side, card_id, target, answers);
  if (!ok) {
    // 分两档: 「这张卡这轮已经打过了」与「被守卫挡住」自己一眼能看出来 (信息类),
    // 其余的 (目标不合法 / 被效果打断) 看不出原因, 算错误
    const current = getBattleState();
    const attacker = current?.cards[card_id];
    if (attacker && attacker.zone === 'FIELD' && attacker.attacked_this_turn) {
      noticeInfo('这张卡本轮已经攻击过 (轮到自己行动时恢复)');
    } else if (current && attacker && isGuardBlocked(current, attacker, target)) {
      noticeInfo('对手场上还有卡, 不能直接打脸 —— 先攻击对手场上的卡');
    } else {
      noticeError('攻击没有生效: 目标不合法, 或这次攻击被打断了');
    }
  }
  clearSelection();
  return ok;
}

async function performOnTarget(target: string) {
  const sel = currentSelection.value;
  if (!sel) {
    return;
  }
  if (sel.effect_id) {
    await runAction(async () => {
      const ok = await operateActivate(sel.side, sel.card_id, sel.effect_id!);
      if (!ok) {
        noticeError('技能发动失败 (条件不满足或次数已用尽)');
      }
      return ok;
    });
    clearSelection();
    return;
  }
  // 普通攻击: 场上若有标了 ask 的技能, 先把「要不要发动」摆出来再打
  const options = askableOptions(sel.side, ATTACK_TIMINGS);
  if (options.length > 0) {
    dialog.value = {
      type: 'confirm',
      side: sel.side,
      title: '这次攻击要发动哪些技能?',
      detail: '这些技能标了要先确认; 不勾选就不发动, 它们各自有自己的默认处理。',
      options,
      run: answers => performAttackWith(sel.side, sel.card_id, target, answers),
    };
    dialogPicked.value = defaultPicked(options);
    return;
  }
  await runAction(() => performAttackWith(sel.side, sel.card_id, target, undefined));
}

async function performPlay(side: PlayerId, slot: number) {
  const sel = currentSelection.value;
  if (!sel || sel.zone !== 'HAND' || sel.side !== side) {
    return;
  }
  await runAction(async () => {
    const ok = await operatePlay(side, sel.card_id, slot);
    if (!ok) {
      const card = state.value?.cards[sel.card_id];
      noticeError(card ? `上场失败 (${blockReasonOf(card) || '现在不能上场'})` : '上场失败');
    }
    return ok;
  });
  clearSelection();
}

async function activateSelected() {
  const sel = currentSelection.value;
  if (!sel || !sel.effect_id) {
    return;
  }
  await runAction(async () => {
    const ok = await operateActivate(sel.side, sel.card_id, sel.effect_id!);
    if (!ok) {
      noticeError('技能发动失败 (条件不满足或次数已用尽)');
    }
    return ok;
  });
  clearSelection();
}

/** 结束行动本身 (不带 runAction, 方便确认框里直接调用) */
async function endTurnRaw(side: PlayerId, answers?: readonly string[]): Promise<boolean> {
  const ok = await operateEndTurn(side, answers);
  clearSelection();
  // 两边都收手后引擎会直接结算并推进回合; 轮到谁走画面中间的回合条一直在显示, 不用再弹提示
  return ok;
}

async function endTurn(side: PlayerId) {
  // 结束行动时同样可能触发标了 ask 的技能, 先问一句再收手
  const options = askableOptions(side, END_TIMINGS);
  if (options.length > 0) {
    dialog.value = {
      type: 'confirm',
      side,
      title: '结束行动前要发动哪些技能?',
      detail: '这些技能会在结束行动时触发, 标了要先确认; 不勾选就不发动。',
      options,
      run: answers => endTurnRaw(side, answers),
    };
    dialogPicked.value = defaultPicked(options);
    return;
  }
  await runAction(() => endTurnRaw(side, undefined));
}

// ---- 点击 ----

function onCardClick(card: CardInstance) {
  const sel = currentSelection.value;
  if (sel && isTargetable(card)) {
    void performOnTarget(card.id);
    return;
  }
  if (!canAct(card.controller)) {
    noticeInfo(practice.value ? '这张卡现在不能操作' : '还没轮到你操作这一边');
    return;
  }
  toggleSelection(card);
}

function onPanelClick(side: PlayerId) {
  const sel = currentSelection.value;
  if (sel && isPanelTargetable(side)) {
    void performOnTarget(side);
    return;
  }
}

function onSlotClick(side: PlayerId, index: number) {
  if (canDropOnSlot(side, index)) {
    void performPlay(side, index);
  }
}

// ---- 拖放 ----

function onDragStart(card: CardInstance, event: DragEvent) {
  if (!dragEnabled.value || !canAct(card.controller)) {
    event.preventDefault();
    return;
  }
  const sel = selection.value;
  selection.value = {
    side: card.controller,
    card_id: card.id,
    zone: card.zone === 'HAND' ? 'HAND' : 'FIELD',
    effect_id: sel && sel.card_id === card.id ? sel.effect_id : null,
  };
  event.dataTransfer?.setData('text/plain', card.id);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
  }
}

function onDragEnd() {
  refresh();
}

/** 把选中的卡拖到目标卡上 */
function onDropOnCard(card: CardInstance, event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
  const sel = currentSelection.value;
  if (!sel) {
    return;
  }
  if (isTargetable(card)) {
    void performOnTarget(card.id);
    return;
  }
  // 把手牌拖到自己的场上卡上 → 放到第一个空位
  if (card.controller === sel.side && sel.zone === 'HAND') {
    const first_empty = firstEmptySlot(card.controller);
    if (first_empty >= 0) {
      void performPlay(card.controller, first_empty);
    }
  }
}

function onPanelDrop(side: PlayerId, event: DragEvent) {
  event.preventDefault();
  if (!currentSelection.value) {
    return;
  }
  if (isPanelTargetable(side)) {
    void performOnTarget(side);
  }
}

/** 落在格子上: 空格 → 上场; 有卡且是合法目标 → 攻击 */
function onSlotDrop(side: PlayerId, index: number, event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
  if (canDropOnSlot(side, index)) {
    void performPlay(side, index);
    return;
  }
  const occupant = fieldSlots(side)[index];
  if (occupant && currentSelection.value) {
    onDropOnCard(occupant, event);
  }
}

function onFieldDrop(side: PlayerId, event: DragEvent) {
  event.preventDefault();
  const sel = currentSelection.value;
  if (!sel || sel.zone !== 'HAND' || sel.effect_id || sel.side !== side) {
    return;
  }
  const first_empty = firstEmptySlot(side);
  if (first_empty >= 0) {
    void performPlay(side, first_empty);
  }
}

// ---------------------------------------------------------------------------
// 会话控制
// ---------------------------------------------------------------------------

const decks = ref<Deck[]>([]);
const playerDecks = computed(() => decks.value.filter(deck => deck.阵营 === '我方'));
const enemyDecks = computed(() => decks.value.filter(deck => deck.阵营 === '敌方'));
const playerDeckId = ref('');
const enemyDeckId = ref('__same__');
const hpPlayer = ref(8000);
const hpEnemy = ref(8000);
const openingHand = ref(5);
const handLimit = ref(8);
const fieldLimit = ref(5);
const energySwitch = ref(true);
const energyStart = ref(1);
const energyPerTurn = ref(1);
const energyCap = ref(10);
const energyRefill = ref(true);
const first = ref<PlayerId>('PLAYER');
const seed = ref(1);
const recycle = ref<'GRAVEYARD' | 'NONE'>('GRAVEYARD');
const drawPerTurn = ref(1);
const recycleLimit = ref(0);
const recyclePenalty = ref(1);
const guardRule = ref(true);
const splashRatio = ref(0.5);
const turnLimit = ref(30);

function buildSetup(): BattleSetup | null {
  const player_deck = decks.value.find(deck => deck.id === playerDeckId.value);
  if (!player_deck) {
    noticeError('请先选择我方卡组');
    return null;
  }
  const enemy_deck =
    enemyDeckId.value === '__same__'
      ? player_deck
      : decks.value.find(deck => deck.id === enemyDeckId.value);
  if (!enemy_deck) {
    noticeError('请先选择敌方卡组');
    return null;
  }
  const mine = resolveDeck(player_deck).卡牌.map(card => card.id);
  const theirs = resolveDeck(enemy_deck).卡牌.map(card => card.id);
  if (mine.length === 0 || theirs.length === 0) {
    noticeError('卡组里没有可用的卡牌');
    return null;
  }
  return {
    我方卡组: mine,
    敌方卡组: theirs,
    种子: seed.value,
    我方生命: hpPlayer.value,
    敌方生命: hpEnemy.value,
    场上上限: fieldLimit.value,
    开局手牌: openingHand.value,
    手牌上限: handLimit.value,
    能量开关: energySwitch.value,
    起始能量: energyStart.value,
    能量增长: energyPerTurn.value,
    能量上限: energyCap.value,
    能量补满: energyRefill.value,
    先手: first.value,
    牌库轮换: recycle.value,
    每回合抽牌: drawPerTurn.value,
    洗牌上限: recycleLimit.value,
    洗牌惩罚: recyclePenalty.value,
    守卫规则: guardRule.value,
    溢出传伤: splashRatio.value,
    回合上限: turnLimit.value,
  };
}

async function startBattle() {
  const setup = buildSetup();
  if (!setup) {
    return;
  }
  muteFx();
  await runAction(async () => {
    await startBattleSession(setup);
    return true;
  });
  clearSelection();
}

async function startPractice() {
  const setup = buildSetup();
  if (!setup) {
    return;
  }
  muteFx();
  await runAction(async () => {
    const created = await startPracticeSession(setup);
    if (!created) {
      noticeError('正式战斗正在进行, 请先结束战斗再进入演习');
      return false;
    }
    return true;
  });
  clearSelection();
}

async function resetPractice() {
  cancelPlayback();
  muteFx();
  await runAction(async () => {
    await resetPracticeSession();
    return true;
  });
  clearSelection();
}

async function leaveSession() {
  cancelPlayback();
  muteFx();
  await runAction(async () => {
    await endBattleSession();
    return true;
  });
  clearSelection();
}

async function toggleBothSides(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  bothSides.value = enabled;
  await runAction(async () => {
    await setControlBothSides(enabled);
    return true;
  });
}

/**
 * 演习里开关能量系统.
 *
 * 正式战斗的能量在开局时定死 —— 那份配置跟着变量快照走, 中途改会和 AI 读到的局面说法对不上.
 * 演习不写变量, 所以可以随手开关, 方便对比「有能量 / 没能量」两套规则的手感;
 * 开关值也会写回演习配置, 「重置演习」后保持不变.
 */
function togglePracticeEnergy(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  energySwitch.value = enabled;
  const next = setPracticeEnergyEnabled(enabled);
  if (!next) {
    noticeError('只有演习模式能中途改能量设置');
  } else {
    noticeInfo(enabled ? '能量已开启, 上场按卡面费用扣能量' : '能量已关闭, 所有卡都能直接上场');
  }
  refresh();
}

async function askAI() {
  if (aiBusy.value || playing.value) {
    return;
  }
  aiBusy.value = true;
  try {
    const ok = await requestAIDecision();
    if (!ok) {
      noticeInfo('现在不需要 AI 行动');
    }
  } catch (error) {
    noticeError(`AI 行动失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    aiBusy.value = false;
    refresh();
  }
}

// ---------------------------------------------------------------------------
// 动画 (FX)
//
// 引擎状态是被原地改写的普通对象, 所以动画没法靠 watch(state) 的引用变化驱动。
// 这里的做法是: 每次 refresh() 把现在的状态和「上一份快照」对一下, 把差异翻译成
// 一次性的动画标记 (抽卡 / 上场 / 攻击 / 受击 / 回复 / 技能 / 倒下)。
// AI 的操作由消息事件在后台结算, 面板每秒轮询一次, 于是天然也走同一条路。
// ---------------------------------------------------------------------------

/** 动画种类 (对应 CSS 里的 .fx-<kind>) */
type FxKind = 'draw' | 'play' | 'attack' | 'hit' | 'heal' | 'skill' | 'death';

/** 一次动画: 种类 + 流水号 (进 key, 号变了元素就重建 → 动画得以重播) + 浮出来的文字 */
interface FxEntry {
  kind: FxKind;
  serial: number;
  text: string;
}

/** 各类动画各自持续多久 (到点就把标记撤掉, 元素落回常态) */
const FX_MS: Record<FxKind, number> = {
  draw: 640,
  play: 640,
  attack: 560,
  hit: 620,
  heal: 700,
  skill: 900,
  death: 760,
};

/** 一张卡在快照里要留的字段 (只留判 diff 用得上的) */
interface CardSnap {
  zone: string;
  slot: number | null;
  hp: number;
  shield: number;
  attacked: boolean;
}

/** 整场战斗的快照 */
interface BattleSnap {
  turn: number;
  active: PlayerId;
  index: number;
  hp: Record<PlayerId, number>;
  cards: Map<string, CardSnap>;
  /** 上次看到第几条引擎日志 (技能发动只能从这里看出来) */
  log_length: number;
}

/** 动画开关 (关掉后「可发动」的高亮光边也一起关) */
const animEnabled = ref(true);
/** 卡上的动画 (卡实例 id → 动画) */
const fxCards = ref<Record<string, FxEntry>>({});
/** 玩家头像上的动画 (掉血 / 回血) */
const fxSides = ref<Partial<Record<PlayerId, FxEntry>>>({});
/** 刚倒下的卡: 在原来的格子里多停一会儿, 好让「倒下」看得见 */
const ghosts = ref<{ side: PlayerId; slot: number; card_id: string }[]>([]);
/** 墓地计数跳动 (每次有新卡进墓地就 +1, 当成 key 用) */
const gravePulse = ref<Partial<Record<PlayerId, number>>>({});

let snapshot: BattleSnap | null = null;
let fxSerial = 0;
/** 下一次 refresh() 只更新快照, 不播动画 (开新局 / 重置 / 回溯时用) */
let fxMuted = false;
const fxTimers = new Map<string, number>();

/** 到点撤销一个动画标记 (同一个 key 之后又被占用过的话, 只撤自己那一次) */
function armFx(key: string, ms: number, clear: () => void) {
  const timer = fxTimers.get(key);
  if (timer !== undefined) {
    window.clearTimeout(timer);
  }
  fxTimers.set(
    key,
    window.setTimeout(() => {
      fxTimers.delete(key);
      clear();
    }, ms),
  );
}

function setCardFx(card_id: string, kind: FxKind, text = '') {
  fxSerial += 1;
  const serial = fxSerial;
  fxCards.value[card_id] = { kind, serial, text };
  armFx(`card:${card_id}`, FX_MS[kind], () => {
    // 期间又播了别的动画 (流水号变了), 就别把新的那一次撤掉
    if (fxCards.value[card_id]?.serial === serial) {
      delete fxCards.value[card_id];
    }
  });
}

function setSideFx(side: PlayerId, kind: FxKind, text = '') {
  fxSerial += 1;
  const serial = fxSerial;
  fxSides.value[side] = { kind, serial, text };
  armFx(`side:${side}`, FX_MS[kind], () => {
    if (fxSides.value[side]?.serial === serial) {
      delete fxSides.value[side];
    }
  });
}

/** 让刚倒下的卡在原格子里多待一会儿 */
function addGhost(card: CardInstance, slot: number | null) {
  if (slot === null || slot < 0) {
    return;
  }
  ghosts.value = ghosts.value.filter(item => item.card_id !== card.id);
  ghosts.value.push({ side: card.controller, slot, card_id: card.id });
  armFx(`ghost:${card.id}`, FX_MS.death, () => {
    ghosts.value = ghosts.value.filter(item => item.card_id !== card.id);
  });
}

/** 墓地里多了一张: 让计数跳一下 */
function bumpGrave(side: PlayerId) {
  fxSerial += 1;
  const serial = fxSerial;
  gravePulse.value[side] = serial;
  armFx(`grave:${side}`, 600, () => {
    if (gravePulse.value[side] === serial) {
      delete gravePulse.value[side];
    }
  });
}

/** 清掉所有动画标记 (换局 / 回退时用, 免得幽灵卡和浮字挂在新局面上) */
function resetFx() {
  for (const timer of fxTimers.values()) {
    window.clearTimeout(timer);
  }
  fxTimers.clear();
  fxCards.value = {};
  fxSides.value = {};
  ghosts.value = [];
  gravePulse.value = {};
}

/** 下一次刷新只记录快照, 不播动画 */
function muteFx() {
  fxMuted = true;
}

function takeSnapshot(current: BattleState): BattleSnap {
  const cards = new Map<string, CardSnap>();
  for (const card of Object.values(current.cards)) {
    cards.set(card.id, {
      zone: card.zone,
      slot: card.slot,
      hp: card.current.hp,
      shield: card.current.shield,
      attacked: card.attacked_this_turn,
    });
  }
  return {
    turn: current.turn,
    active: current.active,
    index: current.active_index,
    hp: { PLAYER: current.players.PLAYER.hp, ENEMY: current.players.ENEMY.hp },
    cards,
    log_length: current.log.length,
  };
}

/**
 * 上场时浮一次字.
 *
 * 有「常驻光环」(只带 modifiers、没有 `on` 的效果) 的卡永远不会触发 `runEffect`,
 * 所以引擎日志里根本不会出现「发动」—— 不在这里补一次, 玩家就完全看不到光环生效了。
 */
function setEnterFx(current: BattleState, card: CardInstance) {
  const auras = cardAuraNames(current, card);
  if (auras.length > 0) {
    setCardFx(card.id, 'skill', `【${auras[0]}】`);
    return;
  }
  setCardFx(card.id, 'play');
}

/**
 * 技能发动浮字显示什么.
 *
 * 优先用日志 detail 里的 `label` (引擎只在一张卡有多个效果时才给出来, 因为单效果卡
 * 的技能名就等于卡名, 说了也没用); 退回来从日志正文里抠【】—— 那句一定是
 * 「「卡名」的【技能名】 发动」。
 */
function fxSkillName(entry: { message: string; detail?: Record<string, unknown> | null }): string {
  const label = typeof entry.detail?.label === 'string' ? entry.detail.label : '';
  if (label) {
    return label;
  }
  const matched = /【(.+?)】/.exec(entry.message);
  return matched ? matched[1] : '';
}

/**
 * 对比快照, 把这一轮发生的事翻成动画.
 *
 * 同一张卡一次只留一个动画: 先算「倒下」, 再算「上场 / 抽卡」, 再算「攻击」,
 * 最后被「受击 / 回复」盖掉 —— 否则一张卡会又抖又闪又涨, 看不出发生了什么。
 */
function diffFx(before: BattleSnap, current: BattleState) {
  const ids = new Set([...before.cards.keys(), ...Object.keys(current.cards)]);
  for (const id of ids) {
    const card = current.cards[id];
    if (!card) {
      continue;
    }
    const was = before.cards.get(id);
    if (!was) {
      // 中途冒出来的卡 (衍生物 / 召唤物)
      if (card.zone === 'FIELD') {
        setEnterFx(current, card);
      } else if (card.zone === 'HAND') {
        setCardFx(id, 'draw');
      }
      continue;
    }
    // 倒下: 从场上离开 (被破坏 / 被除外 / 被收回手牌)
    if (was.zone === 'FIELD' && card.zone !== 'FIELD') {
      addGhost(card, was.slot);
      setCardFx(id, 'death');
      bumpGrave(card.controller);
      continue;
    }
    if (was.zone !== 'FIELD' && card.zone === 'FIELD') {
      setEnterFx(current, card);
    } else if (was.zone !== 'HAND' && card.zone === 'HAND') {
      setCardFx(id, 'draw');
    }
    if (!was.attacked && card.attacked_this_turn) {
      setCardFx(id, 'attack');
    }
    const hp_change = card.current.hp - was.hp;
    const shield_change = card.current.shield - was.shield;
    if (hp_change < 0) {
      setCardFx(id, 'hit', `${hp_change}`);
    } else if (shield_change < 0) {
      setCardFx(id, 'hit', `${shield_change}`);
    } else if (hp_change > 0) {
      setCardFx(id, 'heal', `+${hp_change}`);
    } else if (shield_change > 0) {
      setCardFx(id, 'heal', `+${shield_change}`);
    }
  }

  // 玩家血量
  for (const side of ['PLAYER', 'ENEMY'] as PlayerId[]) {
    const change = current.players[side].hp - before.hp[side];
    if (change < 0) {
      setSideFx(side, 'hit', `${change}`);
    } else if (change > 0) {
      setSideFx(side, 'heal', `+${change}`);
    }
  }

  // 技能发动: 只有引擎日志能说清「哪张卡的哪个技能发动了」
  if (current.log.length > before.log_length) {
    for (const entry of current.log.slice(before.log_length)) {
      if (entry.kind !== 'EFFECT' || entry.engine_only) {
        continue;
      }
      const card_id = typeof entry.detail?.card === 'string' ? String(entry.detail.card) : '';
      const card = card_id ? current.cards[card_id] : undefined;
      if (card) {
        const name = fxSkillName(entry);
        setCardFx(card.id, 'skill', name ? `【${name}】` : '');
      }
    }
  }
}

/** 每次刷新都跑一遍: 更新快照, 并把「和上次不一样的地方」播成动画 */
function syncFx() {
  const current = state.value;
  if (!current) {
    snapshot = null;
    resetFx();
    return;
  }
  const before = snapshot;
  snapshot = takeSnapshot(current);
  if (!before || fxMuted || !animEnabled.value) {
    fxMuted = false;
    resetFx();
    return;
  }
  // 回溯 / 重开会把回合数往回拨: 这种「倒退」不用演出来
  if (current.turn < before.turn) {
    resetFx();
    return;
  }
  diffFx(before, current);
}

/** 此刻真的能主动发动技能的卡 (亮一圈光边; 关掉动效时也不亮) */
const readyIds = computed<Set<string>>(() => {
  const ids = new Set<string>();
  const current = state.value;
  if (!current || current.finished || !animEnabled.value) {
    return ids;
  }
  for (const side of ['PLAYER', 'ENEMY'] as PlayerId[]) {
    // 只有轮到的一方才谈得上「现在能发动」; 不能操作的一方也不该让人看出它能不能用
    if (current.active !== side || !canAct(side)) {
      continue;
    }
    for (const item of listActivatable(current, side)) {
      ids.add(item.card_id);
    }
  }
  return ids;
});

// ---- 供模板读取的小工具 (引擎状态是普通对象, 每次都重新数一遍) ----

function fxKindOf(card_id: string): string {
  void tick.value;
  return fxCards.value[card_id]?.kind ?? '';
}

function fxSerialOf(card_id: string): number {
  void tick.value;
  return fxCards.value[card_id]?.serial ?? 0;
}

function fxTextOf(card_id: string): string {
  void tick.value;
  return fxCards.value[card_id]?.text ?? '';
}

function sideKind(side: PlayerId): string {
  void tick.value;
  return fxSides.value[side]?.kind ?? '';
}

function sideSerial(side: PlayerId): number {
  void tick.value;
  return fxSides.value[side]?.serial ?? 0;
}

function sideText(side: PlayerId): string {
  void tick.value;
  return fxSides.value[side]?.text ?? '';
}

/** 这张卡是不是「刚倒下、还在原地演动画」的幽灵 */
function isGhostCard(card: CardInstance): boolean {
  void tick.value;
  return ghosts.value.some(item => item.card_id === card.id);
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

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

let narrowMq: MediaQueryList | null = null;
let timer: number | null = null;
/** 播放订阅 (挂载时装上, 卸载时撤掉) */
let off_playback: (() => void) | null = null;

function syncNarrow(query: MediaQueryList | MediaQueryListEvent) {
  isNarrow.value = query.matches;
}

/** 窄屏默认关闭拖放 (手机不容易拖准), 用户仍可在设置里手动打开 */
watch(isNarrow, narrow => {
  if (narrow) {
    dragEnabled.value = false;
  }
});

function requestClose() {
  window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
}

async function refreshWorldbook() {
  worldbookStatus.value = await battleWorldbookStatus();
}

onMounted(async () => {
  // 播放内容一录好就立刻送过来 (不等轮询, 免得最终局面先闪一下)
  off_playback = onBattlePlayback(beginPlayback);
  if (typeof viewportWindow.matchMedia === 'function') {
    narrowMq = viewportWindow.matchMedia(`(max-width: ${NARROW_MAX_WIDTH}px)`);
    syncNarrow(narrowMq);
    narrowMq.addEventListener('change', syncNarrow as EventListener);
  }

  try {
    decks.value = loadDecks();
    const deployed = loadDeployedDeck();
    const preferred = deployed?.卡组id ?? '';
    playerDeckId.value = playerDecks.value.some(deck => deck.id === preferred)
      ? preferred
      : (playerDecks.value[0]?.id ?? '');
    enemyDeckId.value = enemyDecks.value[0]?.id ?? '__same__';
    bothSides.value = isControllingBothSides();
  } catch (error) {
    noticeError(error instanceof Error ? error.message : String(error));
  }

  refresh();
  void refreshWorldbook();

  viewportWindow.addEventListener('keydown', onKeydown as EventListener);

  // AI 决策由消息事件在后台结算, 这里轮询一下把结果刷到界面上
  timer = viewportWindow.setInterval(refresh, 1000);
});

onUnmounted(() => {
  if (timer !== null) {
    viewportWindow.clearInterval(timer);
    timer = null;
  }
  viewportWindow.removeEventListener('keydown', onKeydown as EventListener);
  narrowMq?.removeEventListener('change', syncNarrow as EventListener);
  off_playback?.();
  clearPlaybackTimer();
  // 面板卸了就别再让提示的计时器留着
  for (const timer of noticeTimers.values()) {
    viewportWindow.clearTimeout(timer);
  }
  noticeTimers.clear();
  off_pace();
  flushBattlePaceSave();
  off_look();
  flushPanelLookSave();
});
</script>

<style scoped>
.bt-overlay {
  --bt-panel: rgb(var(--panel-tint, 22 24 33) / var(--panel-alpha, 0.94));  --bt-border: rgb(255 255 255 / 0.1);
  --bt-text: #f0f0f5;
  --bt-text-secondary: #a0a0b0;
  --bt-accent: #89b4fa;

  /* 面板固定暗色主题, 让原生控件 (下拉菜单/滚动条/复选框) 也用暗色渲染 */
  color-scheme: dark;

  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  padding: 24px;
  box-sizing: border-box;
  overflow: auto;
  /* 遮罩只轻压暗一层, 页面仍清晰可见; 虚化交给面板自己的 backdrop-filter */
  background: var(--panel-mask, rgb(8 9 13 / 0.28));
  color: var(--bt-text);
  font-family: 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
}

.bt-main {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1280px;
  min-width: 780px;
  height: min(920px, 100%);
  min-height: 520px;
  margin: auto;
  position: relative;
  overflow: hidden;
  background: var(--bt-panel);
  backdrop-filter: blur(var(--panel-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-blur, 10px));
  border: 1px solid var(--bt-border);
  border-radius: 16px;
  box-shadow: 0 24px 80px rgb(0 0 0 / 0.6);
}

.bt-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--bt-border);
}

.bt-title {
  font-size: 1.2em;
  font-weight: 700;
  letter-spacing: 1px;
}

.bt-badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: rgb(137 180 250 / 0.2);
  color: var(--bt-accent);
  font-size: 0.78em;
}

.bt-badge.practice {
  background: rgb(166 227 161 / 0.18);
  color: #a6e3a1;
}

.bt-spacer {
  flex: 1;
}

.bt-btn {
  padding: 5px 12px;
  border: 1px solid var(--bt-border);
  border-radius: 8px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  font-size: 0.86em;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.bt-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.14);
}

.bt-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.bt-btn.primary {
  background: rgb(137 180 250 / 0.24);
  border-color: rgb(137 180 250 / 0.5);
}

.bt-btn.small {
  padding: 4px 10px;
  font-size: 0.82em;
}

.bt-count {
  display: inline-block;
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 999px;
  background: rgb(137 180 250 / 0.28);
  color: #cddcff;
  font-size: 0.86em;
  font-variant-numeric: tabular-nums;
}

.bt-close {
  padding: 5px 12px;
  border: 1px solid var(--bt-border);
  border-radius: 8px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-size: 0.85em;
  cursor: pointer;
}

.bt-close:hover {
  background: rgb(255 255 255 / 0.14);
}

.bt-settings {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--bt-border);
  background: rgb(255 255 255 / 0.03);
}

.bt-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.86em;
  cursor: pointer;
}

.bt-settings-hint {
  font-size: 0.78em;
  color: var(--bt-text-secondary);
}

/* 设置区里的「数字输入」项 (AI 操作间隔 / 结算间隔) */
.bt-pace {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.86em;
  cursor: pointer;
}

.bt-pace input {
  width: 76px;
  padding: 3px 6px;
  border: 1px solid var(--bt-border);
  border-radius: 6px;
  background: rgb(0 0 0 / 0.25);
  color: var(--bt-text);
  font: inherit;
  text-align: right;
}

.bt-pace-unit {
  font-size: 0.9em;
  color: var(--bt-text-secondary);
}

/* ---- 浮动提示层 ----
   面板高度是定死的, 提示条要是按普通流插进去, 内容区就被压小一圈 (卡牌跟着上下跳),
   点一次「攻击失败」整副手牌就挪一次位 —— 所以提示一律浮在棋盘的上面:
   不参与布局, 也不挡操作 (整层不吃鼠标, 只有按钮自己接管点击). */
.bt-floats {
  position: absolute;
  left: 50%;
  bottom: 16px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: min(680px, 86%);
  transform: translateX(-50%);
  pointer-events: none;
}

/* 战斗中要避让底下的操作栏 */
.bt-floats.is-battle {
  bottom: 62px;
}

.bt-float {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--bt-border);
  border-radius: 10px;
  background: rgb(var(--panel-tint, 22 24 33) / var(--panel-dialog-alpha, 0.96));
  color: var(--bt-text);
  box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);
  backdrop-filter: blur(var(--panel-dialog-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-dialog-blur, 10px));
  font-size: 0.86em;
}

.bt-float-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* 信息: 说出来只是确认一下 (4 秒后自己消失) */
.bt-float.info {
  border-color: rgb(137 180 250 / 0.45);
  color: #cfe0ff;
}

/* 错误: 出了岔子, 或「点了没反应又看不出原因」—— 留着等手动关 */
.bt-float.error {
  border-color: rgb(243 139 168 / 0.5);
  color: #ffd3dd;
}

.bt-float.warn {
  border-color: rgb(249 226 175 / 0.4);
  color: #f9e2af;
}

/* 播放条 (AI 操作回放 / 回合结算): 一直在动, 所以用亮一点的高亮色区分 */
.bt-float.play {
  width: 100%;
  border-color: rgb(137 180 250 / 0.5);
  color: #dce8ff;
}

/* 只有按钮接管点击, 提示条本身不挡住下面的卡牌 */
.bt-float button {
  flex: none;
  pointer-events: auto;
}

.bt-float-close {
  padding: 0 2px;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  line-height: 1;
  opacity: 0.65;
  cursor: pointer;
}

.bt-float-close:hover {
  opacity: 1;
}

.bt-play-label {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgb(137 180 250 / 0.28);
  font-size: 0.92em;
}

/* 帧号与说明: 说明太长就省略, 不要挤掉跳过按钮 */
.bt-play-step {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 配置界面 ---- */
.bt-setup {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  overflow: auto;
}

.bt-setup-title {
  margin: 0;
  font-size: 1.05em;
  font-weight: 700;
}

.bt-setup-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bt-setup-row label {
  width: 76px;
  flex: none;
  color: var(--bt-text-secondary);
  font-size: 0.88em;
}

.bt-setup-row select {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--bt-border);
  border-radius: 8px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  font-size: 0.9em;
}

.bt-setup-row select option,
.bt-advanced-grid select option {
  background: #1c1e27;
  color: var(--bt-text);
}

.bt-advanced summary {
  cursor: pointer;
  color: var(--bt-text-secondary);
  font-size: 0.88em;
}

.bt-advanced-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.bt-advanced-grid label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.84em;
  color: var(--bt-text-secondary);
}

.bt-advanced-grid input,
.bt-advanced-grid select {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--bt-border);
  border-radius: 8px;
  background: rgb(255 255 255 / 0.06);
  color: inherit;
  font-family: inherit;
  font-size: 0.95em;
}

.bt-advanced-grid .bt-check {
  gap: 6px;
  color: var(--bt-text);
}

.bt-advanced-grid .bt-check input {
  flex: 0 0 auto;
  width: auto;
  padding: 0;
}

.bt-setup-actions {
  display: flex;
  gap: 10px;
}

.bt-setup-actions .bt-btn {
  padding: 8px 18px;
}

.bt-note {
  margin: 0;
  color: var(--bt-text-secondary);
  font-size: 0.82em;
  line-height: 1.6;
}

/* ---- 棋盘 ---- */
.bt-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  padding: 10px 14px;
  overflow: auto;
}

.bt-side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 12px;
  transition:
    border-color 0.2s,
    background 0.2s;
}

.bt-side.active {
  border-color: rgb(137 180 250 / 0.55);
  background: rgb(137 180 250 / 0.1);
}

.bt-player {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  border: 1px dashed transparent;
  border-radius: 8px;
  font-size: 0.86em;
  /* 掉血浮字挂在头像上, 需要一个定位祖先 */
  position: relative;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.bt-player.targetable {
  border-color: #ff6b6b;
  background: rgb(255 107 107 / 0.12);
  cursor: crosshair;
}

.bt-side-name {
  font-weight: 700;
}

.bt-hp {
  color: #a6e22e;
  font-variant-numeric: tabular-nums;
}

.bt-energy {
  color: #f9e2af;
  font-size: 0.86em;
  font-variant-numeric: tabular-nums;
}

.bt-pile {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border: 1px solid rgb(255 255 255 / 0.1);
  border-radius: 8px;
  background: rgb(255 255 255 / 0.04);
  color: inherit;
  font-family: inherit;
  font-size: 0.8em;
  white-space: nowrap;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.bt-pile:hover:not(:disabled) {
  border-color: rgb(137 180 250 / 0.5);
  background: rgb(137 180 250 / 0.14);
}

.bt-pile:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.bt-pile-label {
  color: var(--bt-text-secondary);
}

.bt-pile b {
  font-variant-numeric: tabular-nums;
}

.bt-pile.deck b {
  color: #8be9fd;
}

.bt-pile.grave {
  border-color: rgb(189 147 249 / 0.28);
}

.bt-pile.grave b {
  color: #d7c4ff;
}

.bt-pile.gone {
  border-color: rgb(243 139 168 / 0.28);
}

.bt-pile.gone b {
  color: #f38ba8;
}

.bt-piles {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* ---- 区域框: 让场上 / 手牌 / 牌库墓地一眼能分开 ---- */
.bt-zone {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px 8px 8px;
  border: 1px solid rgb(255 255 255 / 0.07);
  border-radius: 10px;
  background: rgb(255 255 255 / 0.025);
}

.bt-zone.field {
  border-color: rgb(137 180 250 / 0.2);
  background: rgb(137 180 250 / 0.05);
}

.bt-zone-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 0.74em;
  letter-spacing: 0.08em;
}

.bt-zone-name {
  font-weight: 700;
  color: rgb(255 255 255 / 0.66);
}

.bt-zone.field .bt-zone-name {
  color: var(--bt-accent);
}

.bt-zone-meta {
  color: var(--bt-text-secondary);
  font-variant-numeric: tabular-nums;
}

.bt-field {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 112px;
  padding: 2px;
}

.bt-slot {
  flex: 1 1 138px;
  min-width: 124px;
  max-width: 200px;
  display: flex;
  align-items: stretch;
}

.bt-slot.empty {
  align-items: center;
  justify-content: center;
  min-height: 108px;
  border: 1px dashed rgb(255 255 255 / 0.16);
  border-radius: 8px;
  color: var(--bt-text-secondary);
  font-size: 0.8em;
}

.bt-slot.empty.drop-hint {
  border-color: var(--bt-accent);
  background: rgb(137 180 250 / 0.12);
  cursor: pointer;
}

.bt-slot-empty {
  opacity: 0.6;
}

.bt-card-wrap {
  display: flex;
  width: 100%;
  cursor: grab;
}

.bt-card-wrap:active {
  cursor: grabbing;
}

.bt-hand {
  display: flex;
  gap: 8px;
  padding: 2px;
  overflow-x: auto;
  overflow-y: hidden;
}

.bt-card-wrap.hand {
  position: relative;
  flex: none;
  width: 156px;
}

/* 手牌左上角的上场消耗 */
.bt-cost {
  position: absolute;
  top: 3px;
  left: 3px;
  z-index: 3;
  min-width: 18px;
  padding: 0 4px;
  border-radius: 8px;
  background: #f9e2af;
  color: #241c07;
  font-size: 0.72em;
  font-weight: 700;
  line-height: 1.5;
  text-align: center;
  pointer-events: none;
}

/* 缺能量 / 场上已满的手牌: 再压暗一层, 与「没轮到你」的灰分开看 */
.bt-card-wrap.unaffordable {
  filter: grayscale(0.5) brightness(0.82);
}

.bt-hidden-card {
  flex: none;
  width: 52px;
  height: 74px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bt-border);
  border-radius: 8px;
  background: repeating-linear-gradient(
    45deg,
    rgb(255 255 255 / 0.05) 0 6px,
    rgb(255 255 255 / 0.02) 6px 12px
  );
  color: var(--bt-text-secondary);
  font-size: 0.9em;
}

.bt-empty {
  color: var(--bt-text-secondary);
  font-size: 0.82em;
  padding: 8px 4px;
}

.bt-turnbar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 4px 0;
  border-radius: 8px;
  font-size: 0.88em;
  color: var(--bt-text-secondary);
  /* 每次换手都会重建元素 → 动画重放, 让「回合变了」一眼可见 */
  animation: turn-flash 0.6s ease-out;
}

@keyframes turn-flash {
  from {
    background: rgb(137 180 250 / 0.22);
  }

  to {
    background: transparent;
  }
}

.bt-turn-owner {
  padding: 1px 10px;
  border-radius: 999px;
  font-weight: 700;
}

.bt-turn-owner.mine {
  background: rgb(166 227 161 / 0.18);
  color: #a6e3a1;
}

.bt-turn-owner.theirs {
  background: rgb(243 139 168 / 0.18);
  color: #f38ba8;
}

.bt-result {
  color: #f9e2af;
  font-weight: 700;
}

/* ---- 操作栏 ---- */
.bt-actionbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--bt-border);
  background: rgb(255 255 255 / 0.03);
}

.bt-hint {
  color: var(--bt-text-secondary);
  font-size: 0.82em;
}

/* ---- 窄屏 ---- */
.bt-overlay.is-narrow {
  /* 酒馆窄屏布局会把 body 设为 position:fixed, 使 html 高度塌缩为 0,
     而 html 上的 transform 会成为 fixed 子元素的包含块, 导致面板不可见;
     改用 absolute 挂到 body 上即可。 */
  position: absolute;
  top: 0;
  left: 0;
  right: auto;
  bottom: auto;
  width: 100%;
  height: 100%;
  padding: 0;
}

.bt-overlay.is-narrow .bt-main {
  margin: 0;
  min-width: 0;
  min-height: 0;
  max-width: none;
  height: 100%;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.bt-overlay.is-narrow .bt-header {
  padding: 8px 12px;
  gap: 8px;
}

.bt-overlay.is-narrow .bt-body {
  padding: 8px 10px;
}

.bt-overlay.is-narrow .bt-slot {
  flex: 1 1 96px;
  min-width: 88px;
}

.bt-overlay.is-narrow .bt-player {
  flex-wrap: wrap;
  gap: 6px 10px;
}

.bt-overlay.is-narrow .bt-actionbar {
  padding: 8px 10px;
  gap: 6px;
}

/* ---- 询问 / 确认弹窗 ---- */

.bt-ask-mask {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgb(8 9 13 / 0.55);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.bt-ask-modal {
  width: min(460px, 100%);
  max-height: 100%;
  overflow: auto;
  padding: 16px 18px;
  border: 1px solid var(--bt-border);
  border-radius: 14px;
  /* 与游戏里其它弹窗一样走「弹窗」那一档 (见 共用/外观.ts) */
  background: rgb(var(--panel-tint, 22 24 33) / var(--panel-dialog-alpha, 0.96));
  backdrop-filter: blur(var(--panel-dialog-blur, 10px));
  -webkit-backdrop-filter: blur(var(--panel-dialog-blur, 10px));
  box-shadow: 0 18px 44px rgb(0 0 0 / 0.45);
}

.bt-ask-title {
  margin: 0 0 6px;
  font-size: 1.05em;
}

.bt-ask-detail {
  margin: 0 0 12px;
  color: var(--bt-text-secondary);
  font-size: 0.86em;
  line-height: 1.5;
}

.bt-ask-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bt-ask-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--bt-border);
  border-radius: 8px;
  background: rgb(255 255 255 / 0.04);
  font-size: 0.9em;
  cursor: pointer;
}

.bt-ask-option.picked {
  border-color: rgb(137 180 250 / 0.6);
  background: rgb(137 180 250 / 0.16);
}

.bt-ask-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.bt-ask-count {
  color: var(--bt-text-secondary);
  font-size: 0.82em;
}

/* ---------------------------------------------------------------------------
   动效

   卡牌自己的一次性动画 (抽卡 / 上场 / 攻击 / 受击 / 回复 / 技能 / 倒下) 写在
   BattleCard.vue 里; 这里是面板级别的那几样: 头像掉血、墓地计数跳动。
   标记同样由 refresh() 时的快照对比产生, 到点自动撤掉。
   --------------------------------------------------------------------------- */

/* 刚倒下的卡: 原位置多停一会儿演动画, 但不该再能被拖 / 点 */
.bt-card-wrap.ghost {
  pointer-events: none;
}

/* 玩家头像上的掉血 / 回血浮字 */
.bt-float {
  position: absolute;
  /* 贴着头像行往上浮: 敌方那一行在面板最上面, 从外面飞进来会被滚动容器裁掉 */
  bottom: 2px;
  left: 50%;
  z-index: 6;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgb(8 9 13 / 0.7);
  font-size: 0.9em;
  font-weight: 700;
  white-space: nowrap;
  pointer-events: none;
  animation: bt-float 0.9s ease-out;
}

.bt-player.is-hurt .bt-float {
  color: #ff8a8a;
}

.bt-player.is-heal .bt-float {
  color: #a6e22e;
}

/* 头像被扣血 / 回血的闪一下 (不是自己回合也会闪, 提醒「刚才挨了打」) */
.bt-player.is-hurt {
  animation: bt-hurt 0.55s ease-out;
}

.bt-player.is-heal {
  animation: bt-heal 0.6s ease-out;
}

/* 有新卡进墓地: 计数跳一下 */
.bt-pile.is-pulse {
  animation: bt-pile-pulse 0.6s ease-out;
}

@keyframes bt-float {
  0% {
    opacity: 0;
    transform: translate(-50%, 6px);
  }

  25% {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  100% {
    opacity: 0;
    transform: translate(-50%, -24px);
  }
}

@keyframes bt-hurt {
  0%,
  100% {
    border-color: transparent;
    background: transparent;
  }

  15% {
    border-color: rgb(255 107 107 / 0.8);
    background: rgb(255 107 107 / 0.22);
  }

  50% {
    border-color: rgb(255 107 107 / 0.45);
    background: rgb(255 107 107 / 0.1);
  }
}

@keyframes bt-heal {
  0% {
    background: rgb(166 226 46 / 0.22);
  }

  100% {
    background: transparent;
  }
}

@keyframes bt-pile-pulse {
  0% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgb(215 196 255 / 0.5);
  }

  35% {
    transform: scale(1.12);
    box-shadow: 0 0 0 6px rgb(215 196 255 / 0);
  }

  100% {
    transform: scale(1);
    box-shadow: none;
  }
}
</style>
