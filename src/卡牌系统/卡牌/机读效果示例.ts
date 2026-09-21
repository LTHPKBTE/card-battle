// 卡牌编辑器「插入示例」用的机读效果范例.
//
// 单独成一个文件, 是为了让引擎测试 (`引擎/测试.ts`) 能直接导入并校验它 ——
// 这样示例永远不会与引擎实际支持的语法脱节.

export const 机读效果示例 = `# 一张卡可以写多条效果; 省略 on 的是常驻效果 (只提供 modifiers)
effects:
  # 1) 常驻修正: 己方墓地有 2 张以上「炎龙」时, 攻击力 +20%
  - id: dragon_roar
    modifiers:
      - stat: atk
        layer: PERCENT_ADD
        value: 0.2
        condition:
          count: { zone: GRAVEYARD, controller: SELF, series: 炎龙 }
          op: ">="
          value: 2

  # 2) 攻击后给目标附加「灼烧」: 3 个回合内攻击力 -200
  - id: burn
    on: AFTER_ATTACK
    operations:
      - type: APPLY_STATUS
        target: EVENT_TARGET
        status: 灼烧
        duration: { turns: 3, tick_owner: ANY }
        modifiers:
          - stat: atk
            value: -200

  # 3) 回合结束: 支付自身召唤同伴 (代价支付不出就不发动)
  - id: evolve
    on: TURN_END
    when: CONTROLLER
    condition:
      self: { turns_in_zone: 1 }
    cost:
      - type: DESTROY
        target: SELF
    operations:
      - type: SUMMON
        card: 炎龙之魂

  # 4) 反应型 (陷阱): 我方卡将受到致命伤害时取消这次伤害
  #    上面的攻击后效果只认「本卡自己」, 陷阱要管别人的事就得写 by: ANY
  - id: guard
    on: BEFORE_DAMAGE
    by: ANY
    condition:
      all:
        - event: { lethal: true, target_controller: SELF }
        - self: { zone: FIELD }
    cost:
      - type: MOVE
        target: SELF
        zone: GRAVEYARD
    operations:
      - type: CANCEL

  # 5) 穿盾: 攻击后无视护盾追加 100 点真实伤害
  #    伤害默认先扣护盾 (溢出的部分才扣生命), 写 pierce 才是直接打生命
  - id: pierce
    on: AFTER_ATTACK
    operations:
      - type: DAMAGE
        target: EVENT_TARGET
        value: 100
        pierce: true

  # 6) 护盾: 破盾时永久 +200 攻击力, 同时给自己回 150 点护盾
  #    护盾不会自动回满 (与生命一样是持续状态), 要回盾就得自己写 RESTORE_SHIELD;
  #    回满之后再被打空会再次触发 SHIELD_BROKEN
  - id: bulwark
    on: SHIELD_BROKEN
    operations:
      - type: MODIFY
        target: SELF
        stat: atk
        value: 200
      - type: RESTORE_SHIELD
        target: SELF
        value: 150

  # 7) 值表达式 + 控制流: 对敌方每张卡打「当前攻击力的一半」, 打倒两张就收手
  #    数值不必是常量: 字符串公式 ("SELF.atk / 2") 与结构化写法 ({ op: DIV, ... }) 等价;
  #    还能写 SUM/COUNT/MAX 这类聚合、{ var } 读变量、{ turn } / { random } / { if } 取值
  - id: sweep
    on: MANUAL
    limit: { per: TURN, times: 1 }
    operations:
      # 效果局部变量: 只活在这次结算里 (子效果也读得到), 跨回合要存活就写 scope: BATTLE
      - type: SET_VAR
        var: down
        value: 0
      - type: FOR_EACH
        target: ALL_ENEMIES
        max: 3
        operations:
          - type: DAMAGE
            target: LOOP_ITEM          # 循环里「当前这一张」
            value: "SELF.atk / 2"
          # 多步决策: 打完之后再看它还在不在场上, 决定要不要补刀
          - type: IF
            condition: { target: { of: LOOP_ITEM, zone: FIELD } }
            then:
              - type: DAMAGE
                target: LOOP_ITEM
                value: { op: MUL, args: [{ stat: atk, of: SELF }, 0.25] }
            else:
              - type: ADD_VAR
                var: down
                value: 1
        break_if: { var: down, op: ">=", value: 2 }   # 打倒两张就提前跳出`;
