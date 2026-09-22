// AI 辅助写卡 - 提示词中使用的规范文本
//
// 这里的机读语法必须与 `src/卡牌系统/引擎/schema.ts` 保持一致.
// 引擎语法变化时, 除了 `机读效果.md` 与 `机读效果示例.ts`, 也要同步本文件.

/**
 * 第一原则: 用户说了算 (三个写卡任务共用的开场白).
 *
 * 写在所有规范之前, 让模型先看到「用户可以推翻下面的一切默认值」,
 * 否则它会拿着数值参考里的区间当硬性限制, 把用户想要的强度自行砍掉.
 */
export const 用户优先规范 = `【第一原则: 用户说了算】
  - 用户的明确要求优先于本规范里的任何数值参考、示例与默认写法; 两者冲突时一律以用户为准.
  - 这不是严格的数值游戏, 也不需要对战平衡. 卡牌只为当前剧情服务, 没有「超模」「破坏平衡」这回事 ——
    不要因为「太强了」就擅自把用户点名的强度、机制或数值打折.
  - 用户没提强度时, 才按规范里的数值参考给一个合理档位 (那只是默认档位, 不是上限).
  - 用户点名的机制必须真的实现; 机读语法实在表达不了时, 用最接近的写法并在 ignored 里说明,
    不要默默当作用户没提过.`;

/**
 * 机读效果 (machine_effect) 语法规范.
 *
 * 面向 AI, 只列字段名与枚举值, 尽量压缩 token 但保证可执行.
 */
export const 机读规范 = `【机读效果语法 (machine_effect)】
顶层是一个 JSON 对象, 两种写法二选一:
  A. 多效果: { "effects": [ 效果, ... ] }
  B. 单效果简写: { "on": ..., "operations": [...] }
空对象 {} 表示这张卡没有机读效果.

一条效果可用字段 (所有对象都是严格模式: 出现任何未列出的键都会导致整张卡的机读区失效):
  id        string, 强烈建议写: 就是描述里那个技能名 (如 "医疗指令"). 战斗日志与卡牌动画
            都显示这个名字, 不写的话日志里只剩卡名、动画上没有字; 同名效果还用于 limit 计数
  on        string, 触发时点; 省略 = 常驻效果, 只提供 modifiers
  condition 条件对象, 不满足就不发动
  priority  number, 结算优先级, 大的先结算, 默认 0
  cost      操作数组, 任一操作执行不了则整条效果不发动
  operations 操作数组, 按顺序执行
  modifiers 常驻修正数组 (不触发, 持续改数值)
  limit     { "per": "TURN" | "BATTLE", "times": 正整数 }
  when      "CONTROLLER" | "OPPONENT" | "ANY" (默认 ANY)
  by        "SELF" | "ALLY" | "ENEMY" | "ANY" (默认 SELF), 事件必须由谁发起才触发;
            事件的发起者 = 攻击者 / 上场的卡 / 被抽到的卡
  ask       true 表示「这条效果发动前先问一下玩家」, 省略 = 到点自动发动 (大部分效果都不要写)
  ask_default "RUN" | "SKIP", 可选, 没人回答时怎么办 (默认 RUN = 照常发动)
  zones     区域数组, 默认 ["FIELD"]

触发时点 on 只能取:
  MANUAL, BATTLE_START, TURN_START, TURN_END, SIDE_START, SIDE_END, SIDE_CHANGE,
  BEFORE_ATTACK, AFTER_ATTACK,
  BEFORE_DAMAGE, AFTER_DAMAGE, BEFORE_HEAL, AFTER_HEAL, BEFORE_DESTROY,
  AFTER_DESTROY, SHIELD_BROKEN, ON_SUMMON, ON_LEAVE, ON_DRAW, ON_RECYCLE
(MANUAL = 等玩家/AI 主动发动, 不由事件触发;
 SHIELD_BROKEN = 某张卡的护盾被打到 0 时; 护盾重新生成后再被打空会再次触发)

回合结构 (直接决定上面这些时点什么时候响):
  一个回合 = 先手方行动一次 + 后手方行动一次, 合起来才算一回合.
  每一方行动的开始与结束用 SIDE_START / SIDE_END 表示, 双方都行动完后才开始回合结算,
  这时才结算回合制持续伤害/加成, 并触发 TURN_END.
  TURN_START / TURN_END 没有归属方 (不属于任何一边), 所以给它们写 when 没有意义 (会照常发动);
  卡面写「每次换人时 / 每当我方开始行动时」用 SIDE_CHANGE / SIDE_START.

区域 zone 只能取: DECK, HAND, FIELD, GRAVEYARD, BANISHED

目标 target / from / to 三选一写法:
  1) 关键字字符串: SELF, CONTROLLER, OPPONENT, EVENT_ACTOR, EVENT_TARGET,
     EVENT_SOURCE, ALL_ALLIES, ALL_ENEMIES, ALL_FIELD, RANDOM_ALLY, RANDOM_ENEMY,
     LOOP_ITEM (只在 FOR_EACH 的循环体里有效, 指当前这一轮处理的那张卡)
  2) { "id": "卡牌实例id" }
  3) 查询对象 (全部字段可选):
     { "zone": 区域, "controller": "SELF"|"OPPONENT", "owner": "SELF"|"OPPONENT",
       "series": "系列名", "type": "类型", "name": "卡名", "rarity": "稀有度",
       "has_status": "状态键", "exclude_self": true, "exclude_event_target": true,
       "max": 正整数, "sort": "ATK_DESC"|"ATK_ASC"|"SHIELD_DESC"|"SHIELD_ASC"|"HP_ASC"|"HP_DESC"|"RANDOM" }

所有「数字」都能写成三种形式 (下面统称 **数值**), 卡面上有「一半」「之和」「当前」这类说法时用它:
  1) 常量: 100
  2) 公式字符串: "SELF.atk / 2"
  3) 结构化: { "op": "DIV", "args": [{ "stat": "atk", "of": "SELF" }, 2] }

公式里能写的东西 (大小写不敏感; 字段只能取 atk / shield_max / shield / hp_max / hp):
  SELF.atk / EVENT_TARGET.hp / OPPONENT.hp      目标.字段 (可以换任意目标关键字或 { id })
  atk / hp_max                                  省略目标 = 自己
  $变量名                                        读变量 (没写过就是 0)
  TURN                                          当前回合数
  EVENT.value / EVENT.lethal                    当前事件的数值 / 是否致命一击
  RANDOM                                        [0,1) 的随机数 (按战斗种子, 回放可复现)
  MAX(a, b) MIN(a, b)                            取大 / 取小
  SUM(ALL_FIELD, atk) AVG(...) MAX(ALL_FIELD, hp) MIN(...)  对一批目标统计
  COUNT(ALL_ENEMIES)                             数目标个数
  POW(a, b) ABS(x) FLOOR(x) CEIL(x) ROUND(x)     幂 / 绝对值 / 取整
  运算: + - * / % ^ 与括号; ^ 是幂; 除以 0 得 0 (不会崩)
  例: "SELF.atk * 2" / "(TURN + 1) * 100" / "MAX(SELF.atk, 500) / 2" / "SUM(ALL_FIELD, atk) / 4"
  注意 MAX(SELF.atk) 是「全场最高的攻击力」(聚合), MAX(SELF.atk, 400) 是「取大的那个」(普通运算)

结构化写法 (与字符串糖等价, 二选一; 一个对象只属于一个家族, 不能混着写):
  { "op": "ADD|SUB|MUL|DIV|MOD|POW|MIN|MAX|NEG|ABS|FLOOR|CEIL|ROUND", "args": [数值...] }
  { "stat": "atk", "of": 目标 }
  { "var": "变量名", "scope": "EFFECT|BATTLE" }
  { "agg": "SUM|COUNT|MAX|MIN|AVG", "of": 目标, "stat": "atk" }
  { "event": "value|lethal" } / { "turn": true } / { "random": true }
  { "if": 条件, "then": 数值, "else": 数值 }   (按条件在两个数值里挑一个, 省略 else 得 0)

条件 condition 写法:
  组合: { "all": [条件...] } / { "any": [条件...] } / { "not": 条件 }
  叶子 (op 只能是 ">", ">=", "=", "<=", "<"):
  { "exists": 查询对象 }
  { "count": 查询对象, "op": 比较符, "value": 数字 }
  { "self": { "zone": 区域, "hp_below": 数字, "hp_percent_below": 0到1,
              "atk_above": 数字, "turns_in_zone": 数字, "has_status": "状态键",
              "stat": "atk"|"shield_max"|"shield"|"hp_max"|"hp", "op": 比较符, "value": 数字 } }
  { "event": { "value_above": 数字, "value_below": 数字, "lethal": true|false,
               "target_controller": "SELF"|"OPPONENT" } }
  { "player": { "controller": "SELF"|"OPPONENT", "hp_below": 数字,
                "hp_percent_below": 0到1, "stat": "hp"|"hp_max",
                "op": 比较符, "value": 数字 } }
  { "flag": "标记键", "op": 比较符, "value": 数值 }
  { "var": "变量名", "op": 比较符, "value": 数值, "scope": "EFFECT"|"BATTLE" (默认 EFFECT) }
  { "target": { "of": 目标, "exists": 布尔,
                "zone": 区域, "hp_below": 数值, "hp_percent_below": 数值, "atk_above": 数值,
                "turns_in_zone": 数值, "has_status": "状态键",
                "stat": "atk"|"shield_max"|"shield"|"hp_max"|"hp", "op": 比较符, "value": 数值,
                "count_op": 比较符, "count_value": 数值 } }
    (问「某个目标现在怎样」, 例如「那只卡还在场上吗 / 场上还有两名敌人吗」;
     of 省略 = SELF, exists 默认 true, count_* 用来数符合条件的个数)
  { "chance": 0到1 的小数 }

操作 operations / cost 每一项至少含 type (下面写「数值」的地方都能用上面的公式):
  DAMAGE        { "target": 目标, "value": 数值, "pierce": 可选布尔 }
                (默认先扣护盾, 溢出部分才扣生命; pierce: true = 无视护盾直接打生命)
  HEAL          { "target": 目标, "value": 数值 }
  RESTORE_SHIELD { "target": 目标 (默认 SELF), "value": 数值 (不会超过护盾上限) }
  CLEAR_SHIELD  { "target": 目标 (默认 事件目标), 把护盾直接清零 (相当于被打破, 会触发 SHIELD_BROKEN) }
  DESTROY       { "target": 目标 }
  MOVE          { "target": 目标, "zone": 区域 (默认 GRAVEYARD) }
  SUMMON        { "card": "卡牌库 id 或卡名", "value": 数量, "data": { "owner": "OPPONENT" } }
  DRAW          { "value": 张数, "data": { "player": "OPPONENT" } }
  ATTACK        { "target": 目标, "pierce": 可选布尔, "ignore_guard": 可选布尔 }
                (让来源卡攻击, 每回合 1 次; 默认规则下对手场上还有卡时不能直接攻击对手本人,
                 卡面写着「无视守卫 / 越过守卫直接打脸」时加 "ignore_guard": true)
  MODIFY        { "target": 目标, "stat": 数值键, "layer": 层级, "value": 数值, "duration": 持续 }
                (stat 为 shield 时直接增减护盾池; 为 hp 时直接治疗/伤害; 其余走常驻修正)
  TRANSFER_MAX  { "from": 目标, "to": 目标, "stat": "hp_max"|"shield_max"|"shield", "value": 数值 }
                (shield 表示直接搬运护盾池里的现有值)
  APPLY_STATUS  { "target": 目标, "status": "叠加键", "name": "显示名", "value": 层数,
                  "duration": 持续, "modifiers": 修正数组, "effects": 效果数组 }
  REMOVE_STATUS { "target": 目标, "status": "叠加键" }
  ADD_EFFECT    { "target": 目标, "effects": 效果数组 }
  CANCEL        {}
  SCALE_EVENT   { "value": 倍率 }
  SET_FLAG      { "target": 目标, "data": { "标记键": 数字 } }
  SET_VAR       { "var": "变量名", "value": 数值, "scope": "EFFECT"|"BATTLE" }
  ADD_VAR       { "var": "变量名", "value": 数值, "scope": "EFFECT"|"BATTLE" }
  IF            { "condition": 条件, "then": 操作数组, "else": 操作数组 (可省略) }
  FOR_EACH      { "target": 目标, "max": 正整数 (默认 32), "operations": 操作数组,
                  "break_if": 条件 (可选) }
  REPEAT        { "times": 数值 (最多 64), "operations": 操作数组, "break_if": 条件 (可选) }
  BREAK         {}  (跳出最内层循环)
  STOP          {}  (停掉这条效果剩下的操作)
每个操作都可以额外带 "condition".

变量 (写法与用法的三条要点):
  - SET_VAR 赋值, ADD_VAR 累加; 变量名用中文也行 (读的时候写 $变量名).
  - 默认 scope 是 "EFFECT": 只活在本次效果结算期间 (包含它触发的连锁), 结束后自动消失,
    适合「先打一下, 看死没死, 再决定要不要弃牌」这种中间结果;
    要跨效果/跨回合记住东西 (倒了几个、攒了几层) 就写 "scope": "BATTLE", 它随战斗快照保存.
  - 读变量用公式里的 $变量名, 或者条件里的 { "var": ... }; 没写过的变量是 0.

控制流 / 循环:
  - IF 用来二选一; FOR_EACH 按目标逐个处理 (循环体里 LOOP_ITEM 是当前这张卡, $index 是它的下标, 从 0 开始);
    REPEAT 重复 times 次 ($round 是当前轮数, 从 0 开始).
  - 提前收手: 用 "break_if" 条件 (写不动了会继续循环) 或循环体里的 BREAK;
    STOP 是停掉整条效果, 适合「代价太大就别往下做了」.
  - 上限 (引擎会自行截断, 不用自己防): FOR_EACH 最多 32 个目标, REPEAT 最多 64 轮,
    循环最多套 4 层, 单条效果总共最多 800 个操作.

修正 modifier:
  { "stat": "atk"|"shield_max"|"shield"|"hp_max"|"hp",
    "layer": "SET"|"ADD"|"PERCENT_ADD"|"PERCENT_MULT"|"OVERRIDE" (默认 ADD),
    "value": 数值, "target": 目标, "duration": 持续, "condition": 条件 }
  PERCENT_ADD 的 0.2 = +20%; PERCENT_MULT 的 0.2 = 乘 1.2
  shield_max = 护盾上限; shield = 当前护盾池 (可直接加减, 加减后自动限幅到 0..上限,
    上限被改小时当前护盾也会被一起压下来)
  注意: 修正里的公式在「这条修正被创建时」算一次并固定下来 (常驻效果 = 卡上场那一刻),
    之后不会再变; 所以别在常驻修正里写「跟着当前攻击力变」的公式 ——
    那种每回合重算的写法: 用 on: "TURN_START" 的效果 + ADD_EFFECT 每回合重铺一次修正.

持续 duration:
  { "turns": 正整数, "tick_on": "TURN_START"|"TURN_END" (默认 TURN_END) }
  注意: turns 以「回合」计数 (双方各行动一次算一回合), 不是一个回合里的某一边行动;
  tick_on 决定在回合结算的哪一头让它流逝.
  给别人加状态时状态携带的子效果里的 when 参照的是**带着状态的那张卡的控制者**

必须遵守的规则:
  1. 效果默认只在来源卡位于场上时生效; 要在抽牌/墓地等区域生效必须显式写 zones
  2. 触发时点的归属默认是本卡自己: "on": "AFTER_ATTACK" = 本卡攻击后, "on": "ON_SUMMON" = 本卡上场时.
     卡面说的就是本卡自己做的事时, 不要加 by;
     要让别的卡做的事也触发本效果 (陷阱、我方任意卡攻击后、被敌人攻击时…) 必须显式写
     by: "ALLY" | "ENEMY" | "ANY"
  3. 主动发动的效果写 on: "MANUAL"
  4. 数值与护盾的关系: 伤害默认先扣护盾 (盾归零时的溢出部分才扣生命), 所以护盾高的卡
     等于多一段临时生命; 只有字面写着「无视护盾 / 直接造成伤害 / 真实伤害」的效果才用 pierce: true
     另外: 若这一击把卡打死了, 超出它剩余生命的伤害会按比例传给它的控制者 (默认 50%),
     所以字面写着「穿透 / 贯穿 / 溢出的伤害仍会伤到对手」的效果不需要额外写什么, 规则本身就会这么做
  5. 攻击对手本人受「守卫」限制: 普通攻击 (ATTACK) 在对手场上还有卡时打不到他本人
     (卡面写「无视守卫」的才写 ignore_guard: true); 但 DAMAGE 这类直接对玩家生效的效果伤害不受守卫限制 ——
     卡面写着「直接对敌方造成伤害 / 无视守卫的伤害」就写 DAMAGE target: OPPONENT
  6. 护盾是会被打空的: 打空后要再恢复必须显式写 RESTORE_SHIELD 或给 shield 加修正,
     卡自己不会自动回盾; 想写「回盾」类效果就用 RESTORE_SHIELD
  7. 键名、枚举值必须与上面完全一致 (大小写敏感), 不得发明新字段
  8. 效果里的循环/变量是有上限的 (见上), 不要用它们做真正的程序 —— 只用来表达卡面那几十个字
  9. 语法表达不了的效果: 直接省略, 不要硬凑
  10. 「是否发动由玩家/角色自己决定」的效果才写 ask: true (加上 ask_default: "SKIP" 更稳),
     普通的自动效果千万不要写 ask, 否则每回合都要玩家点一次确认`;

/** 卡牌自然语言部分的写作规范 */
export const 卡牌写作规范 = `【卡牌字段规范】
  name        卡名, 简短有辨识度
  series      系列名, 同系列卡可以被机读条件检索, 无系列填空字符串
  rarity      "N" | "R" | "SR" | "SSR" | "UR"
  stars       0-8 的整数 (0 表示未设置)
  type        "从者" | "魔法" | "咒术" | "道具" | "陷阱" | "场地" | "联动" 或自定义
  attribute   属性, 如 "火" / "水" / "光" / "量子"
  gender      性别
  race        种族
  height      身高 (字符串)
  atk / shield / hp  数值字符串, 如 "300"; 可带计算说明如 "300[+100]"
              shield = 护盾: 战斗中伤害默认先扣护盾, 护盾扣完才开始扣生命;
              「回盾 / 加盾 / 破盾时」这类效果用机读区的 RESTORE_SHIELD 与 on: "SHIELD_BROKEN"
  energy      上场消耗的能量, 数值字符串 (如 "2"; 0 或空字符串 = 不花能量).
              能量上限随回合数增长 (默认第 1 回合 1 点, 每回合 +1, 最多 10),
              所以「N 费」相当于「这张卡最早第 N 回合能上场」—— 强卡给高价才能晚出场.
              没写强度要求时按档位给: 杂兵 1, 中坚 2-3, 王牌/UR 4-6, 纯剧情卡可以不花能量
  description 自然语言效果描述, 玩家可读, 与 machine_effect 表达同一件事
              一张卡有多条效果时, 每条效果单独一行, 行首用 ①②③… 编号, 用换行符隔开
              (即 JSON 字符串里写 \\n), 不要把多条效果挤成一段
  machine_effect 机读效果对象, 见机读效果语法

数值参考 (8 星 UR 的粗略基准):
  低费/杂兵: atk 100-300, shield 0-100, hp 500-1000
  中坚: atk 300-600, shield 100-300, hp 1000-1800
  王牌/UR: atk 600-1200, shield 300-800, hp 1800-3000
  效果越强, 数值越低; 纯数值卡可以给高数值, 但不要超出上述范围太多;
  护盾不是每张卡都必须有 (没有就填 0), 它是「多出来的一段血」, 不宜超过同档攻击力的 1-2 倍

⚠️ 以上只是「用户没提要求时」的默认档位, 不是上限:
  用户说要什么强度就给什么强度 (可以远远超出上面的区间), 也不需要和对手卡组保持平衡 ——
  这不是竞技游戏, 卡牌是给剧情用的.`;

/** 输出格式约定 (所有任务共用) */
export const 输出约定 = `【输出要求】
  - 只输出一个 JSON 对象, 不要任何解释文字, 不要 Markdown 代码块
  - 所有字符串用双引号, 不要写注释
  - 字符串里的换行必须写成 \\n 转义, 不要在 JSON 里直接换行
  - 用不到的可选字段直接省略或填空字符串 / 空数组
  - 确保 JSON 能被标准解析器解析 (不要出现尾逗号)`;
