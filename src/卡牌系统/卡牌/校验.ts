// 卡牌数据完整性检查
//
// 用途: 在卡牌库 / 卡组面板里标出「还没填完」或「数值引擎读不懂」的卡牌,
// 并在编辑器里把这些输入框标成灰色虚线, 让作者知道该补哪里.
//
// 只判断数据本身是否可用, 不涉及任何内部实现细节, 也不会在界面上暴露内部状态.

import { parseMachineEffect } from '../引擎/schema.ts';

/** 可以被检查的卡牌 (卡牌库的 Card 与 AI 生成的草稿都满足) */
export interface IssueCheckableCard {
  name?: string | null;
  atk?: string | null;
  shield?: string | null;
  hp?: string | null;
  energy?: string | null;
  machine_effect?: unknown;
}

/** 出问题的字段, 供编辑器标灰 */
export type CardIssueField = 'name' | 'atk' | 'shield' | 'hp' | 'energy' | 'machine_effect';

export interface CardIssue {
  /** 对应编辑器里的输入框 */
  field: CardIssueField;
  /** 面向作者的说明, 例如「卡名还没填」 */
  message: string;
}

const STAT_FIELDS: { field: 'atk' | 'shield' | 'hp'; label: string }[] = [
  { field: 'atk', label: 'ATK' },
  { field: 'shield', label: '护盾' },
  { field: 'hp', label: 'HP' },
];

/**
 * 检查一张卡牌的数据是否填完整、数值能否被引擎读懂.
 * 返回空数组表示这张卡没问题.
 */
export function cardIssues(card: IssueCheckableCard): CardIssue[] {
  const issues: CardIssue[] = [];

  if (!String(card.name ?? '').trim()) {
    issues.push({ field: 'name', message: '卡名还没填' });
  }

  const stats = STAT_FIELDS.map(item => ({ ...item, text: String(card[item.field] ?? '').trim() }));
  if (stats.every(item => item.text === '')) {
    // 三项都空通常是「还没开始填」; 只填其中一两项 (例如纯魔法卡只写 HP) 不算问题
    for (const item of stats) {
      issues.push({ field: item.field, message: 'ATK / 护盾 / HP 都还没填' });
    }
  } else {
    for (const item of stats) {
      if (item.text !== '' && !/-?\d+(?:\.\d+)?/.test(item.text)) {
        issues.push({ field: item.field, message: `${item.label} 不是数字: ${item.text}` });
      }
    }
  }

  // 能量留空 = 0 费, 不算问题; 填了就必须能让引擎读出数字
  const energy = String(card.energy ?? '').trim();
  if (energy !== '' && !/-?\d+(?:\.\d+)?/.test(energy)) {
    issues.push({ field: 'energy', message: `能量不是数字: ${energy}` });
  }

  if (card.machine_effect !== undefined && card.machine_effect !== null) {
    const { error } = parseMachineEffect(card.machine_effect);
    if (error) {
      issues.push({ field: 'machine_effect', message: `机读效果用不了: ${error}` });
    }
  }

  return issues;
}

/** 这张卡是否有数据问题 */
export function hasCardIssues(card: IssueCheckableCard): boolean {
  return cardIssues(card).length > 0;
}

/** 按 id 汇总一批卡牌的数据问题 (列表渲染用, 避免每张卡重复校验) */
export function cardIssueMap(cards: (IssueCheckableCard & { id: string })[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const card of cards) {
    const issues = cardIssues(card);
    if (issues.length > 0) {
      // 同一个原因只提示一次 (例如三项数值都空)
      map.set(card.id, [...new Set(issues.map(issue => issue.message))]);
    }
  }
  return map;
}
