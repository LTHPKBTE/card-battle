// 战斗引擎 - 测试用卡牌
//
// 这些卡牌覆盖引擎的各个机制, 也是机读区 YAML 的书写范例:
//   1 愿之芽     常驻修正 (只在场上生效)
//   2 献祭之愿   时点条件 + 代价 + 召唤 (献祭自身召唤)
//   3 祈愿之星   被召唤出来的衍生物
//   4 灼热之爪   攻击后给目标附加带持续时间的状态 (状态强度用公式算自施法者攻击力)
//   5 血之契约   转移生命上限 (转移量用公式算自自身当前上限, 带持续时间到期回滚)
//   6 深渊陷阱   致命伤害时支付自身取消该次伤害
//   7 同族之力   带条件的常驻修正 (场上同系列卡达到 2 张时才生效)
//   8 狂战之魂   自动攻击 (回合结束时自己打对方血最少的卡)
//   9 研究笔记   玩家主动发动: 抽 2 张牌 (每回合 1 次)
//  10 封印之匣   玩家主动发动但代价付不出 → 不发动
//  11 薪火相传   牌库抽空、墓地洗回牌库时回复玩家生命 (在墓地生效)
//  12 背水一战   玩家生命低于 50% 时全体攻击力 +50%
//  13 战意       玩家主动发动, 每次 +100 攻击力 (叠加)
//  14 壁垒之核   护盾池: 每回合回盾 + 破盾时反击 (回盾量算自当前护盾上限)
//  15 换防号令   换边触发器 (SIDE_CHANGE) + when: CONTROLLER 只认自己那一半
//  16 凋零之咒   回合制持续伤害: 给对手挂一个「回合结算时掉血」的状态
//  17 推演之环   值表达式 + 控制流: 循环打敌方、打完看死没死再决定后续、变量计数
//  18 绝路之誓   判定用「加成后的数值」: 阈值写成公式, 生命上限被加成/削弱时跟着变
//  19 火种       便宜的能量消耗卡 (1 费)
//  20 燎原       昂贵的能量消耗卡 (4 费)
//  21 守夜人     机读区 ask: true: 发动前要先问玩家一句 (用答案清单控制)
//  22 值夜灯     收手时询问 (SIDE_END): answers 写在决策块最外层
//
// 能量 (卡牌库字段 `energy`, 不是机读区) 是上场要消耗的通用资源:
// 缺省曲线是「第 1 回合 1 点, 每回合 +1, 10 点封顶, 每次自己行动开始补满」,
// 所以「一回合铺一堆小卡」与「攒一个大怪」之间必须做选择.
//
// 回合模型提醒: 一个回合 = 双方各行动一次。
//   TURN_START / TURN_END 是双方共用的时点 (没有归属方, `when` 在这里不起作用);
//   需要「只在我方行动时」就写 SIDE_START / SIDE_END / SIDE_CHANGE 配 `when: CONTROLLER`.

import type { LibraryCardLike } from './适配.ts';

export const 测试卡: LibraryCardLike[] = [
  {
    id: '1',
    name: '愿之芽',
    series: '祈愿',
    rarity: 'R',
    stars: 1,
    type: '从者',
    attribute: '光',
    gender: '女',
    race: '精灵',
    height: '120cm',
    atk: '300',
    shield: '100',
    hp: '800',
    description: '初生的祈愿。',
    machine_effect: {
      // 单条常驻效果: 只提供 modifiers, 没有 on
      modifiers: [{ stat: 'atk', value: 200 }],
    },
  },
  {
    id: '2',
    name: '献祭之愿',
    series: '祈愿',
    rarity: 'SR',
    stars: 3,
    type: '魔法',
    attribute: '光',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '0',
    hp: '500',
    description: '在场上停留一个回合后, 献祭自身召唤祈愿之星。',
    machine_effect: {
      effects: [
        {
          id: 'sacrifice',
          // 回合结束时结算 (整轮): turns_in_zone 也按回合数增长
          on: 'TURN_END',
          condition: { self: { turns_in_zone: 1 } },
          cost: [{ type: 'DESTROY', target: 'SELF' }],
          operations: [{ type: 'SUMMON', card: '祈愿之星' }],
        },
      ],
    },
  },
  {
    id: '3',
    name: '祈愿之星',
    series: '祈愿',
    rarity: 'SSR',
    stars: 5,
    type: '从者',
    attribute: '光',
    gender: '',
    race: '星灵',
    height: '',
    atk: '1200',
    shield: '600',
    hp: '1500',
    description: '由祈愿汇聚而成的星灵。',
    machine_effect: {
      modifiers: [{ stat: 'atk', value: 300 }],
    },
  },
  {
    id: '4',
    name: '灼热之爪',
    series: '炎龙',
    rarity: 'SR',
    stars: 2,
    type: '从者',
    attribute: '火',
    gender: '男',
    race: '龙',
    height: '180cm',
    atk: '600',
    shield: '200',
    hp: '900',
    description: '每次攻击都会让目标灼烧 (灼烧强度为自身攻击力的三分之一)。',
    machine_effect: {
      effects: [
        {
          id: 'burn',
          on: 'AFTER_ATTACK',
          operations: [
            {
              type: 'APPLY_STATUS',
              target: 'EVENT_TARGET',
              status: '灼烧',
              name: '灼烧',
              duration: { turns: 3 },
              // 公式里的 SELF = 施加状态的那张卡 (施法者), 且在挂状态时算一次定下来;
              // 灼热之爪攻击力 600 → 灼烧 -200
              modifiers: [{ stat: 'atk', value: '-SELF.atk / 3' }],
            },
          ],
        },
      ],
    },
  },
  {
    id: '5',
    name: '血之契约',
    series: '祈愿',
    rarity: 'R',
    stars: 1,
    type: '咒术',
    attribute: '暗',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '0',
    hp: '1000',
    description: '上场时把自身生命上限的四成转移给同伴。',
    machine_effect: {
      effects: [
        {
          id: 'pact',
          on: 'ON_SUMMON',
          operations: [
            {
              type: 'TRANSFER_MAX',
              from: 'SELF',
              to: { zone: 'FIELD', controller: 'SELF', exclude_self: true, max: 1, sort: 'HP_DESC' },
              stat: 'hp_max',
              // 转移量跟自己的当前上限走 (上限被加成/削弱时转移量也跟着变): 1000 × 0.4 = 400
              value: 'SELF.hp_max * 0.4',
              duration: { turns: 2 },
            },
          ],
        },
      ],
    },
  },
  {
    id: '6',
    name: '深渊陷阱',
    series: '深渊',
    rarity: 'UR',
    stars: 4,
    type: '陷阱',
    attribute: '暗',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '0',
    hp: '300',
    description: '我方卡牌将受到致命伤害时, 支付自身使该次伤害无效。',
    machine_effect: {
      effects: [
        {
          id: 'abyss',
          on: 'BEFORE_DAMAGE',
          // 反应型: 敌方也能发起这次伤害, 所以不限制发起者
          by: 'ANY',
          condition: {
            all: [{ event: { lethal: true, target_controller: 'SELF' } }, { self: { zone: 'FIELD' } }],
          },
          cost: [{ type: 'MOVE', target: 'SELF', zone: 'GRAVEYARD' }],
          operations: [{ type: 'CANCEL' }],
        },
      ],
    },
  },
  {
    id: '7',
    name: '同族之力',
    series: '祈愿',
    rarity: 'SR',
    stars: 2,
    type: '场地',
    attribute: '光',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '0',
    hp: '600',
    description: '我方场上存在两张以上祈愿系列卡牌时, 自身攻击力 +300。',
    machine_effect: {
      modifiers: [
        {
          stat: 'atk',
          value: 300,
          condition: {
            count: { zone: 'FIELD', controller: 'SELF', series: '祈愿' },
            op: '>=',
            value: 2,
          },
        },
      ],
    },
  },
  {
    id: '8',
    name: '狂战之魂',
    series: '狂战',
    rarity: 'SR',
    stars: 3,
    type: '从者',
    attribute: '火',
    gender: '男',
    race: '战士',
    height: '190cm',
    atk: '700',
    shield: '300',
    hp: '1000',
    description: '回合结束时自动攻击敌方生命值最低的卡牌。',
    machine_effect: {
      effects: [
        {
          id: 'berserk',
          // 回合结算时点: 双方都行动完之后才轮到它出手
          on: 'TURN_END',
          operations: [
            {
              type: 'ATTACK',
              target: { zone: 'FIELD', controller: 'OPPONENT', max: 1, sort: 'HP_ASC' },
            },
          ],
        },
      ],
    },
  },
  {
    id: '9',
    name: '研究笔记',
    series: '秘典',
    rarity: 'R',
    stars: 1,
    type: '魔法',
    attribute: '风',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '0',
    hp: '400',
    description: '每回合一次, 主动发动抽两张牌。',
    machine_effect: {
      effects: [
        {
          id: 'study',
          on: 'MANUAL',
          limit: { per: 'TURN', times: 1 },
          operations: [{ type: 'DRAW', value: 2 }],
        },
      ],
    },
  },
  {
    id: '10',
    name: '封印之匣',
    series: '秘典',
    rarity: 'R',
    stars: 1,
    type: '魔法',
    attribute: '暗',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '0',
    hp: '400',
    description: '主动发动: 破坏自己场上的「研究笔记」并回复 1000 点生命。代价付不出时不会发动。',
    machine_effect: {
      effects: [
        {
          id: 'seal',
          on: 'MANUAL',
          cost: [
            {
              type: 'DESTROY',
              target: { zone: 'FIELD', controller: 'SELF', name: '不存在的东西', max: 1 },
            },
          ],
          operations: [{ type: 'HEAL', target: 'CONTROLLER', value: 1000 }],
        },
      ],
    },
  },
  {
    id: '11',
    name: '薪火相传',
    series: '薪火',
    rarity: 'SR',
    stars: 2,
    type: '魔法',
    attribute: '光',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '0',
    hp: '400',
    description: '牌库抽空、墓地洗回牌库时, 回复我方 500 点生命。',
    machine_effect: {
      effects: [
        {
          id: 'inherit',
          on: 'ON_RECYCLE',
          zones: ['GRAVEYARD'],
          operations: [{ type: 'HEAL', target: 'CONTROLLER', value: 500 }],
        },
      ],
    },
  },
  {
    id: '12',
    name: '背水一战',
    series: '薪火',
    rarity: 'SSR',
    stars: 4,
    type: '场地',
    attribute: '光',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '0',
    hp: '800',
    description: '我方生命值低于一半时, 回合开始让我方全体攻击力提升 50%。',
    machine_effect: {
      effects: [
        {
          id: 'last_stand',
          on: 'TURN_START',
          condition: { player: { hp_percent_below: 0.5 } },
          operations: [
            {
              type: 'MODIFY',
              target: 'ALL_ALLIES',
              stat: 'atk',
              layer: 'PERCENT_ADD',
              value: 0.5,
              duration: { turns: 1 },
            },
          ],
        },
      ],
    },
  },
  {
    id: '13',
    name: '战意',
    series: '狂战',
    rarity: 'R',
    stars: 1,
    type: '魔法',
    attribute: '火',
    gender: '',
    race: '',
    height: '',
    atk: '300',
    shield: '0',
    hp: '500',
    description: '主动发动: 自身获得 2 回合「战意」, 每层攻击力 +100。',
    machine_effect: {
      effects: [
        {
          id: 'battle_spirit',
          on: 'MANUAL',
          operations: [
            {
              type: 'APPLY_STATUS',
              target: 'SELF',
              status: '战意',
              name: '战意',
              duration: { turns: 2 },
              modifiers: [{ stat: 'atk', value: 100 }],
            },
          ],
        },
      ],
    },
  },
  {
    id: '14',
    name: '壁垒之核',
    series: '壁垒',
    rarity: 'SSR',
    stars: 3,
    type: '从者',
    attribute: '地',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '300',
    hp: '500',
    description: '每回合结束时恢复护盾上限一半的护盾 (上限被改时跟着变); 护盾被打破时自身攻击力永久 +300。',
    machine_effect: {
      effects: [
        {
          id: 'mend',
          // 回合结算时点: 每回合 (双方各行动一次后) 回一次盾
          on: 'TURN_END',
          // 回盾量算自当前护盾上限: 300 / 2 = 150; 上限被加成时回得更多
          operations: [{ type: 'RESTORE_SHIELD', target: 'SELF', value: 'SELF.shield_max / 2' }],
        },
        {
          id: 'shatter',
          on: 'SHIELD_BROKEN',
          // actor 是「破盾的那张卡」= 本卡, 所以默认 by: SELF 就是「本卡被破盾时」
          operations: [{ type: 'MODIFY', target: 'SELF', stat: 'atk', value: 300 }],
        },
      ],
    },
  },
  {
    id: '15',
    name: '换防号令',
    series: '壁垒',
    rarity: 'R',
    stars: 1,
    type: '魔法',
    attribute: '地',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '0',
    hp: '400',
    description: '每次换边到我方时, 我方场上全体攻击力 +50 (永久叠加)。',
    machine_effect: {
      effects: [
        {
          id: 'relay',
          // 换边触发器: 每回合派发 2 次 (先手→后手, 后手→下回合先手),
          // when: CONTROLLER 让它只在「换到我方」那一次发动
          on: 'SIDE_CHANGE',
          when: 'CONTROLLER',
          operations: [{ type: 'MODIFY', target: 'ALL_ALLIES', stat: 'atk', value: 50 }],
        },
      ],
    },
  },
  {
    id: '16',
    name: '凋零之咒',
    series: '深渊',
    rarity: 'SR',
    stars: 2,
    type: '咒术',
    attribute: '砕',
    gender: '',
    race: '',
    height: '',
    atk: '0',
    shield: '0',
    hp: '400',
    description: '上场时给对手全体挂上「凋零」: 每回合结算时受到 100 点穿透伤害, 持续 2 回合。',
    machine_effect: {
      effects: [
        {
          id: 'wither',
          on: 'ON_SUMMON',
          operations: [
            {
              type: 'APPLY_STATUS',
              target: 'ALL_ENEMIES',
              status: '凋零',
              name: '凋零',
              duration: { turns: 2 },
              effects: [
                {
                  // 回合制持续伤害: 写在 TURN_END (= 回合结算) 上
                  on: 'TURN_END',
                  operations: [{ type: 'DAMAGE', target: 'SELF', value: 100, pierce: true }],
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    id: '17',
    name: '推演之环',
    series: '祈愿',
    rarity: 'SSR',
    stars: 4,
    type: '魔法',
    attribute: '光',
    gender: '',
    race: '',
    height: '',
    atk: '800',
    shield: '0',
    hp: '600',
    description:
      '玩家主动发动: 对敌方每张卡造成「当前攻击力 ×2」的伤害, 打倒两张就收手; 每打倒一张额外打击对手 200 点。',
    machine_effect: {
      effects: [
        {
          id: 'sweep',
          on: 'MANUAL',
          limit: { per: 'TURN', times: 1 },
          operations: [
            // 效果局部变量 (只活在这次结算里, 循环里读得到)
            { type: 'SET_VAR', var: '倒下', value: 0 },
            {
              type: 'FOR_EACH',
              target: 'ALL_ENEMIES',
              max: 3,
              operations: [
                // 字符串公式: 当前攻击力 ×2
                { type: 'DAMAGE', target: 'LOOP_ITEM', value: 'SELF.atk * 2' },
                // 多步决策: 打完再看它还在不在场上
                {
                  type: 'IF',
                  condition: { target: { of: 'LOOP_ITEM', zone: 'FIELD' } },
                  then: [],
                  else: [
                    { type: 'ADD_VAR', var: '倒下', value: 1 },
                    { type: 'DAMAGE', target: 'OPPONENT', value: 200 },
                  ],
                },
              ],
              // 打倒两张就提前跳出
              break_if: { var: '倒下', op: '>=', value: 2 },
            },
          ],
        },
      ],
    },
  },
  {
    id: '18',
    name: '绝路之誓',
    series: '薪火',
    rarity: 'SR',
    stars: 3,
    type: '从者',
    attribute: '光',
    gender: '',
    race: '',
    height: '',
    atk: '300',
    shield: '0',
    hp: '1000',
    description: '自身生命值低于生命上限的三成时, 攻击力 +400。',
    machine_effect: {
      modifiers: [
        {
          stat: 'atk',
          value: 400,
          // 阈值写成公式而不是写死 300: 判定用的是「当前上限」,
          // 上限被加成/削弱时阈值跟着走 (卡面的 1000 只是初始值)
          condition: { self: { stat: 'hp', op: '<=', value: 'SELF.hp_max * 0.3' } },
        },
      ],
    },
  },
  {
    id: '19',
    name: '火种',
    series: '薪火',
    rarity: 'N',
    stars: 1,
    type: '从者',
    attribute: '火',
    gender: '',
    race: '',
    height: '',
    atk: '200',
    shield: '0',
    hp: '400',
    energy: '1',
    description: '一点火苗。',
  },
  {
    id: '20',
    name: '燎原',
    series: '薪火',
    rarity: 'SSR',
    stars: 5,
    type: '从者',
    attribute: '火',
    gender: '',
    race: '',
    height: '',
    atk: '900',
    shield: '200',
    hp: '1500',
    energy: '4',
    description: '烧起来就收不住了。',
  },
  {
    id: '21',
    name: '守夜人',
    series: '薪火',
    rarity: 'SR',
    stars: 3,
    type: '从者',
    attribute: '暗',
    gender: '',
    race: '',
    height: '',
    atk: '400',
    shield: '0',
    hp: '900',
    energy: '2',
    description: '每次攻击后可以选择进入守夜 (攻击力 +500, 持续 3 回合); 不确认就不会发动。',
    machine_effect: {
      effects: [
        {
          id: '守夜',
          on: 'AFTER_ATTACK',
          // ask: 面板会先把这条效果摆出来问一句「要不要发动」,
          // 玩家的选择作为 answers 传给 attack(); 没人回答时按 ask_default 处理
          ask: true,
          ask_default: 'SKIP',
          operations: [
            {
              type: 'MODIFY',
              target: 'SELF',
              stat: 'atk',
              layer: 'ADD',
              value: 500,
              duration: { turns: 3 },
            },
          ],
        },
      ],
    },
  },
  {
    id: '22',
    name: '值夜灯',
    series: '薪火',
    rarity: 'N',
    stars: 1,
    type: '从者',
    attribute: '光',
    gender: '',
    race: '',
    height: '',
    atk: '300',
    shield: '0',
    hp: '700',
    energy: '1',
    description: '收手时可以选择点亮它 (攻击力 +100, 持续 2 回合); 不确认就不会发动。',
    machine_effect: {
      effects: [
        {
          id: '值夜',
          on: 'SIDE_END',
          ask: true,
          ask_default: 'SKIP',
          operations: [
            {
              type: 'MODIFY',
              target: 'SELF',
              stat: 'atk',
              layer: 'ADD',
              value: 100,
              duration: { turns: 2 },
            },
          ],
        },
      ],
    },
  },
];

/** 机读区写法有误的卡 (用于验证校验错误不会让整张卡不可用) */
export const 非法卡: LibraryCardLike = {
  id: 'bad',
  name: '坏掉的卡',
  atk: '100',
  hp: '100',
  machine_effect: { effects: [{ on: 'NOT_A_TIMING', operations: [] }] },
};
