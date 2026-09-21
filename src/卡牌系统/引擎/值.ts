// 战斗引擎 - 值表达式: 字符串糖的语法分析 + 机读区的规范化
//
// 机读区里的「数值」有三种写法, 最终都编译成 `types.ts` 里的 `ValueExpr` 树:
//
// ```yaml
// value: 100                                                    # 常量 (老写法, 行为完全不变)
// value: { op: DIV, args: [{ stat: atk, of: SELF }, 2] }        # 结构化: 当前攻击力的一半
// value: "SELF.atk / 2"                                         # 字符串糖, 编译成同一棵树
// ```
//
// 三个设计要点:
// 1. **编译发生在卡牌校验期** (`parseMachineEffect`), 不是战斗结算期 ——
//    公式写错、操作名打错、控制流缺字段, 在保存卡牌时就会报错, 不会等到打起来才发现;
// 2. **没有 eval** —— 字符串由本文件里的手写词法/语法分析器处理, 只认下面列出的
//    目标关键字、数值字段与函数名, 其余一律报错;
// 3. **求值不在这里** —— 目标是运行期信息 (要解析 LOOP_ITEM、读随机数), 所以求值在
//    `conditions.ts` 的 `evalValue()` 里. 本文件只依赖 `types.ts` 与操作注册表 (取已知操作名).
import { hasOperation } from './operations.ts';
import type {
  AggOp,
  Condition,
  EffectDefinition,
  ModifierSpec,
  NumberSpec,
  OperationSpec,
  StatKey,
  TargetCondition,
  TargetSpec,
  ValueExpr,
  ValueOp,
  VarScope,
} from './types.ts';

/** 一棵值表达式最多多少个节点 (防手滑写出巨型公式) */
export const VALUE_NODE_LIMIT = 200;
/** 值表达式最大嵌套深度 */
export const VALUE_DEPTH_LIMIT = 12;
/** 字符串糖的最大长度 */
export const VALUE_TEXT_LIMIT = 400;

/** 编译期错误 (带出错位置, 由 parseMachineEffect 转成给作者看的 error 文本) */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** 一元运算 */
const UNARY_OPS = new Set<ValueOp>(['NEG', 'ABS', 'FLOOR', 'CEIL', 'ROUND']);
/** 函数名 → 运算 (字符串糖里 `FLOOR(x)` 这种写法) */
const FUNCTION_OPS: Record<string, ValueOp> = {
  NEG: 'NEG',
  ABS: 'ABS',
  FLOOR: 'FLOOR',
  CEIL: 'CEIL',
  ROUND: 'ROUND',
  POW: 'POW',
  MIN: 'MIN',
  MAX: 'MAX',
};
/** 聚合函数 */
const AGG_FUNCTIONS: Record<string, AggOp> = {
  SUM: 'SUM',
  COUNT: 'COUNT',
  AVG: 'AVG',
};
/** 单个目标 (可以写 `X.atk`) */
const SINGLE_TARGETS = new Set([
  'SELF',
  'CONTROLLER',
  'OPPONENT',
  'EVENT_ACTOR',
  'EVENT_TARGET',
  'EVENT_SOURCE',
  'LOOP_ITEM',
  'ITEM',
]);
/** 一批目标 (可以聚合) */
const MULTI_TARGETS = new Set(['ALL_ALLIES', 'ALL_ENEMIES', 'ALL_FIELD', 'RANDOM_ALLY', 'RANDOM_ENEMY']);
/** 全部目标关键字 */
const TARGET_KEYWORDS = new Set([...SINGLE_TARGETS, ...MULTI_TARGETS]);
/** 数值字段名 (与 `StatKey` 一致) */
const STAT_FIELDS = new Set<StatKey>(['atk', 'shield_max', 'shield', 'hp_max', 'hp']);

function isTargetBase(base: string): boolean {
  return TARGET_KEYWORDS.has(base.toUpperCase());
}

/** 裸符号 → 目标描述 (`item` 是 `LOOP_ITEM` 的别名) */
function bareTargetOf(base: string): TargetSpec {
  const upper = base.toUpperCase();
  if (upper === 'ITEM') {
    return 'LOOP_ITEM';
  }
  if (TARGET_KEYWORDS.has(upper)) {
    return upper as TargetSpec;
  }
  throw new ValueError(`不是目标关键字: ${base}`);
}

// ---------------------------------------------------------------------------
// 字符串糖: 词法分析
// ---------------------------------------------------------------------------

type TokenKind = 'number' | 'ident' | 'var' | 'op' | 'punct';

interface Token {
  kind: TokenKind;
  text: string;
  /** 数字 token 的值 */
  value: number;
}

const PUNCT = new Set(['(', ')', ',', '.']);

/** 标识符: 允许中文 (卡牌字段里中文很常见) */
function isIdentStart(ch: string): boolean {
  return /[A-Za-z_\u4e00-\u9fa5]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_\u4e00-\u9fa5]/.test(ch);
}

function tokenize(text: string): Token[] {
  if (text.length > VALUE_TEXT_LIMIT) {
    throw new ValueError(`表达式太长 (超过 ${VALUE_TEXT_LIMIT} 个字符)`);
  }
  const tokens: Token[] = [];
  let index = 0;

  while (index < text.length) {
    const ch = text[index];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      index += 1;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[index + 1] ?? ''))) {
      let end = index;
      while (end < text.length && /[0-9.]/.test(text[end])) {
        end += 1;
      }
      const raw = text.slice(index, end);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new ValueError(`不是一个数字: ${raw}`);
      }
      tokens.push({ kind: 'number', text: raw, value });
      index = end;
      continue;
    }

    if (ch === '$') {
      let end = index + 1;
      while (end < text.length && isIdentPart(text[end])) {
        end += 1;
      }
      const name = text.slice(index + 1, end);
      if (!name) {
        throw new ValueError('$ 后面要跟变量名');
      }
      tokens.push({ kind: 'var', text: name, value: 0 });
      index = end;
      continue;
    }

    if (isIdentStart(ch)) {
      let end = index;
      while (end < text.length && isIdentPart(text[end])) {
        end += 1;
      }
      tokens.push({ kind: 'ident', text: text.slice(index, end), value: 0 });
      index = end;
      continue;
    }

    if ('+-*/%^'.includes(ch)) {
      tokens.push({ kind: 'op', text: ch, value: 0 });
      index += 1;
      continue;
    }

    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', text: ch, value: 0 });
      index += 1;
      continue;
    }

    throw new ValueError(`表达式里有不认识的字符: ${ch}`);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// 字符串糖: 语法分析
// ---------------------------------------------------------------------------

/** 一个「裸符号」实参: `ALL_FIELD` / `SELF.atk` 这种纯标识符组成的参数 */
interface BareSymbol {
  base: string;
  field: string | null;
  /** 占用了几个 token */
  length: number;
}

class ValueParser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  /** 全文解析; 还有剩余 token 说明写了两段表达式 */
  parse(): ValueExpr {
    const expr = this.parseSum();
    if (this.pos < this.tokens.length) {
      throw new ValueError(`多余的内容: ${this.peek()?.text ?? ''}`);
    }
    return expr;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private eat(text: string): boolean {
    if (this.peek()?.text === text) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expect(text: string): void {
    if (!this.eat(text)) {
      throw new ValueError(`缺少 ${text} (在 ${this.peek()?.text ?? '表达式结尾'} 前)`);
    }
  }

  /** `+` / `-` */
  private parseSum(): ValueExpr {
    let left = this.parseProduct();
    for (;;) {
      const token = this.peek();
      if (token?.kind === 'op' && (token.text === '+' || token.text === '-')) {
        this.pos += 1;
        const right = this.parseProduct();
        left = {
          kind: 'op',
          op: token.text === '+' ? 'ADD' : 'SUB',
          args: [left, right],
        };
        continue;
      }
      return left;
    }
  }

  /** `*` / `/` / `%` */
  private parseProduct(): ValueExpr {
    let left = this.parsePower();
    for (;;) {
      const token = this.peek();
      if (token?.kind === 'op' && (token.text === '*' || token.text === '/' || token.text === '%')) {
        this.pos += 1;
        const right = this.parsePower();
        const op: ValueOp = token.text === '*' ? 'MUL' : token.text === '/' ? 'DIV' : 'MOD';
        left = { kind: 'op', op, args: [left, right] };
        continue;
      }
      return left;
    }
  }

  /** `^` 幂运算 (右结合) */
  private parsePower(): ValueExpr {
    const left = this.parseUnary();
    if (this.eat('^')) {
      return { kind: 'op', op: 'POW', args: [left, this.parsePower()] };
    }
    return left;
  }

  /** 一元负号 */
  private parseUnary(): ValueExpr {
    if (this.eat('-')) {
      return { kind: 'op', op: 'NEG', args: [this.parseUnary()] };
    }
    if (this.eat('+')) {
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ValueExpr {
    const token = this.peek();
    if (!token) {
      throw new ValueError('表达式不完整');
    }

    if (token.kind === 'number') {
      this.pos += 1;
      return { kind: 'const', value: token.value };
    }

    if (token.kind === 'var') {
      this.pos += 1;
      return { kind: 'var', name: token.text, scope: 'EFFECT' };
    }

    if (token.text === '(') {
      this.pos += 1;
      const inner = this.parseSum();
      this.expect(')');
      return inner;
    }

    if (token.kind === 'ident') {
      // 函数调用
      if (this.peek(1)?.text === '(') {
        return this.parseCall();
      }
      // `RANDOM` 也可以不带括号
      if (token.text.toUpperCase() === 'RANDOM') {
        this.pos += 1;
        return { kind: 'random' };
      }
      if (token.text.toUpperCase() === 'TURN') {
        this.pos += 1;
        return { kind: 'turn' };
      }
      return this.parsePath();
    }

    throw new ValueError(`不认识的写法: ${token.text}`);
  }

  /** `SELF.atk` / `EVENT.value` / `atk` (省略目标 = SELF) */
  private parsePath(): ValueExpr {
    const base = this.peek();
    if (!base || base.kind !== 'ident') {
      throw new ValueError('缺少数值名称');
    }
    this.pos += 1;

    if (this.eat('.')) {
      const field = this.peek();
      if (!field || field.kind !== 'ident') {
        throw new ValueError(`${base.text}. 后面缺少字段名`);
      }
      this.pos += 1;
      return this.qualified(base.text, field.text);
    }

    // 单个名字: 数值字段名 (默认取自己) 或 TURN / RANDOM
    const upper = base.text.toUpperCase();
    if (upper === 'TURN') {
      return { kind: 'turn' };
    }
    if (upper === 'RANDOM') {
      return { kind: 'random' };
    }
    const stat = base.text.toLowerCase() as StatKey;
    if (STAT_FIELDS.has(stat)) {
      return { kind: 'stat', stat, of: 'SELF' };
    }
    throw new ValueError(`不认识的数值名称: ${base.text} (写成 「目标.字段」 或 atk / hp 这类字段名)`);
  }

  /** `目标.字段` 或 `EVENT.xxx` */
  private qualified(base: string, field: string): ValueExpr {
    const base_upper = base.toUpperCase();
    const field_lower = field.toLowerCase();

    if (base_upper === 'EVENT') {
      if (field_lower === 'value') {
        return { kind: 'event', key: 'value' };
      }
      if (field_lower === 'lethal') {
        return { kind: 'event', key: 'lethal' };
      }
      throw new ValueError(`EVENT 只有 value / lethal 两个字段, 没有 ${field}`);
    }

    if (!STAT_FIELDS.has(field_lower as StatKey)) {
      throw new ValueError(`不认识的数值字段: ${base}.${field}`);
    }
    return { kind: 'stat', stat: field_lower as StatKey, of: bareTargetOf(base) };
  }

  /** 函数调用: `MIN(a, b)` / `SUM(ALL_FIELD, atk)` / `COUNT(ALL_ENEMIES)` */
  private parseCall(): ValueExpr {
    const name = this.readIdent().toUpperCase();
    this.expect('(');

    const agg = AGG_FUNCTIONS[name];
    if (agg) {
      return this.parseAggregate(name, agg);
    }
    const op = FUNCTION_OPS[name];
    if (!op) {
      throw new ValueError(`不认识的函数: ${name}`);
    }
    if (op === 'MIN' || op === 'MAX') {
      const aggregate = this.tryParseMinMaxAggregate(op);
      if (aggregate) {
        return aggregate;
      }
    }
    const args: ValueExpr[] = [];
    if (!this.eat(')')) {
      do {
        args.push(this.parseSum());
      } while (this.eat(','));
      this.expect(')');
    }

    if (UNARY_OPS.has(op)) {
      if (args.length !== 1) {
        throw new ValueError(`${name}() 只能有一个参数`);
      }
      return { kind: 'op', op, args };
    }
    if (args.length < 2) {
      throw new ValueError(`${name}() 至少要两个参数`);
    }
    return { kind: 'op', op, args };
  }

  /** `SUM(ALL_FIELD, atk)` / `AVG(...)` / `COUNT(ALL_ENEMIES)` */
  private parseAggregate(name: string, op: AggOp): ValueExpr {
    const bare = this.readBare();
    if (!bare || !isTargetBase(bare.base)) {
      throw new ValueError(`${name}() 的第一个参数要写成目标关键字, 例如 ${name}(ALL_FIELD, atk)`);
    }
    const of = bareTargetOf(bare.base);

    if (op === 'COUNT') {
      if (bare.field) {
        throw new ValueError('COUNT() 只数目标数量, 不写字段');
      }
      this.expect(')');
      return { kind: 'agg', op: 'COUNT', of, stat: 'hp' };
    }

    let field = bare.field;
    if (field) {
      this.expect(')');
    } else {
      this.expect(',');
      field = this.readIdent();
      this.expect(')');
    }

    const stat = field.toLowerCase() as StatKey;
    if (!STAT_FIELDS.has(stat)) {
      throw new ValueError(`不认识的数值字段: ${field}`);
    }
    return { kind: 'agg', op, of, stat };
  }

  /**
   * `MIN` / `MAX` 的聚合写法 (对一批目标取极值).
   *
   * 读不出来时**不消耗任何 token**, 交给普通的 n 元运算处理 —— 所以
   * `MIN(ALL_FIELD, atk)` 是聚合, 而 `MIN(SELF.atk, 500)` 是普通的取小.
   */
  private tryParseMinMaxAggregate(op: 'MIN' | 'MAX'): ValueExpr | null {
    const saved = this.pos;
    const bare = this.peekBare();
    if (!bare || !isTargetBase(bare.base)) {
      return null;
    }
    const delim = this.peek(bare.length)?.text;

    if (bare.field) {
      // `MAX(SELF.atk)` 是聚合; `MAX(SELF.atk, 5)` 是普通的取大
      if (delim !== ')') {
        return null;
      }
      const stat = bare.field.toLowerCase() as StatKey;
      if (!STAT_FIELDS.has(stat)) {
        return null;
      }
      this.pos = saved + bare.length;
      this.expect(')');
      return { kind: 'agg', op, of: bareTargetOf(bare.base), stat };
    }

    // 只有目标关键字: 多目标必须补一个字段 (MAX(ALL_FIELD, atk))
    if (MULTI_TARGETS.has(bare.base.toUpperCase())) {
      if (delim === ')') {
        throw new ValueError(`${op}(ALL_FIELD) 还差一个字段名, 例如 ${op}(ALL_FIELD, atk)`);
      }
      if (delim !== ',') {
        return null;
      }
      this.pos = saved + bare.length;
      this.expect(',');
      const field = this.readIdent().toLowerCase() as StatKey;
      if (!STAT_FIELDS.has(field)) {
        throw new ValueError(`不认识的数值字段: ${field}`);
      }
      this.expect(')');
      return { kind: 'agg', op, of: bareTargetOf(bare.base), stat: field };
    }

    return null;
  }

  /** 读一个标识符 token */
  private readIdent(): string {
    const token = this.peek();
    if (!token || token.kind !== 'ident') {
      throw new ValueError('这里要写一个名称');
    }
    this.pos += 1;
    return token.text;
  }

  /** 只看不取: 当前位置是否能读成裸符号 */
  private peekBare(): BareSymbol | null {
    const first = this.peek();
    if (!first || first.kind !== 'ident') {
      return null;
    }
    if (this.peek(1)?.text === '.') {
      const field = this.peek(2);
      if (!field || field.kind !== 'ident') {
        return null;
      }
      return { base: first.text, field: field.text, length: 3 };
    }
    return { base: first.text, field: null, length: 1 };
  }

  /** 读一个裸符号 (读不出来时报错) */
  private readBare(): BareSymbol | null {
    const bare = this.peekBare();
    if (!bare) {
      return null;
    }
    this.pos += bare.length;
    return bare;
  }
}

/** 解析字符串糖; 失败抛 ValueError */
export function parseValueText(text: string): ValueExpr {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ValueError('表达式是空的');
  }
  const tokens = tokenize(trimmed);
  return new ValueParser(tokens).parse();
}

// ---------------------------------------------------------------------------
// 结构化写法 → AST
// ---------------------------------------------------------------------------

const BINARY_OPS = new Set<ValueOp>(['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'POW', 'MIN', 'MAX']);
const AGG_OPS = new Set<AggOp>(['SUM', 'COUNT', 'MAX', 'MIN', 'AVG']);

/**
 * 表达式对象的「家族」: 用哪个键开头, 就决定它允许带哪些键.
 *
 * 顺序有意义 —— `{ agg: 'SUM', of: ..., stat: ... }` 里也有 `stat`,
 * 所以 `stat` 必须放到最后判断.
 */
const VALUE_KEYS: Record<string, readonly string[]> = {
  op: ['op', 'args'],
  agg: ['agg', 'of', 'stat'],
  var: ['var', 'scope'],
  event: ['event'],
  turn: ['turn'],
  random: ['random'],
  if: ['if', 'then', 'else'],
  stat: ['stat', 'of'],
};

/** 编译过程中的计数 (节点数 / 深度) */
interface CompileState {
  nodes: number;
}

function asRecord(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValueError(`${path} 要写成数字、字符串表达式或表达式对象`);
  }
  return raw as Record<string, unknown>;
}

/**
 * 把机读区里写的「数值」编译成 AST.
 *
 * - 数字 → 常量
 * - 字符串 → 字符串糖
 * - 对象 → 结构化 (`{ op }` / `{ stat }` / `{ var }` / `{ agg }` / `{ event }` / `{ turn }` /
 *   `{ random }` / `{ if }`)
 */
export function compileValue(raw: unknown, path = 'value', state: CompileState = { nodes: 0 }, depth = 0): ValueExpr {
  if (depth > VALUE_DEPTH_LIMIT) {
    throw new ValueError(`${path} 嵌套太深 (超过 ${VALUE_DEPTH_LIMIT} 层)`);
  }
  state.nodes += 1;
  if (state.nodes > VALUE_NODE_LIMIT) {
    throw new ValueError(`表达式太复杂 (超过 ${VALUE_NODE_LIMIT} 个节点)`);
  }

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw new ValueError(`${path} 不是有效数字`);
    }
    return { kind: 'const', value: raw };
  }

  if (typeof raw === 'string') {
    try {
      return parseValueText(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ValueError(`${path} 的表达式有误: ${message}`);
    }
  }

  if (typeof raw === 'boolean') {
    return { kind: 'const', value: raw ? 1 : 0 };
  }

  const record = asRecord(raw, path);
  const keys = Object.keys(record);
  // 一份表达式对象只属于一个「家族」, 用哪个键开头就决定了它带哪些键
  const key = Object.keys(VALUE_KEYS).find(candidate => record[candidate] !== undefined);
  if (!key) {
    throw new ValueError(`${path} 的表达式对象要写 ${Object.keys(VALUE_KEYS).join(' / ')} 中的一个`);
  }
  const unknown = keys.filter(candidate => !VALUE_KEYS[key].includes(candidate));
  if (unknown.length > 0) {
    throw new ValueError(`${path} 的表达式对象里有不认识的键: ${unknown.join(', ')} (${key} 只认 ${VALUE_KEYS[key].join(' / ') || '无'})`);
  }
  const next = (value: unknown, suffix: string, next_depth = depth + 1): ValueExpr =>
    compileValue(value, `${path}.${suffix}`, state, next_depth);

  switch (key) {
    case 'op': {
      const op = String(record.op).toUpperCase() as ValueOp;
      const args_raw = Array.isArray(record.args) ? (record.args as unknown[]) : null;
      if (!args_raw) {
        throw new ValueError(`${path}.op 需要配 args 数组`);
      }
      if (UNARY_OPS.has(op)) {
        if (args_raw.length !== 1) {
          throw new ValueError(`${path}: ${op} 只能有一个参数`);
        }
        return { kind: 'op', op, args: [next(args_raw[0], 'args[0]')] };
      }
      if (!BINARY_OPS.has(op)) {
        throw new ValueError(`${path}: 不认识 op: ${record.op}`);
      }
      if (op === 'POW' || op === 'SUB' || op === 'DIV' || op === 'MOD') {
        if (args_raw.length !== 2) {
          throw new ValueError(`${path}: ${op} 需要两个参数`);
        }
      } else if (args_raw.length < 1) {
        throw new ValueError(`${path}: ${op} 至少需要一个参数`);
      }
      return {
        kind: 'op',
        op,
        args: args_raw.map((item, index) => next(item, `args[${index}]`)),
      };
    }
    case 'stat': {
      const stat = String(record.stat).toLowerCase() as StatKey;
      if (!STAT_FIELDS.has(stat)) {
        throw new ValueError(`${path}: 不认识的数值字段 ${record.stat}`);
      }
      const of = record.of === undefined ? 'SELF' : (record.of as TargetSpec);
      return { kind: 'stat', stat, of };
    }
    case 'var': {
      const name = String(record.var);
      if (!name) {
        throw new ValueError(`${path}.var 不能是空串`);
      }
      const scope = record.scope === undefined ? 'EFFECT' : (String(record.scope).toUpperCase() as VarScope);
      if (scope !== 'EFFECT' && scope !== 'BATTLE') {
        throw new ValueError(`${path}.scope 只能是 EFFECT / BATTLE`);
      }
      return { kind: 'var', name, scope };
    }
    case 'agg': {
      const op = String(record.agg).toUpperCase() as AggOp;
      if (!AGG_OPS.has(op)) {
        throw new ValueError(`${path}: 不认识 agg: ${record.agg}`);
      }
      const of = record.of === undefined ? 'ALL_FIELD' : (record.of as TargetSpec);
      const stat = record.stat === undefined ? 'hp' : (String(record.stat).toLowerCase() as StatKey);
      if (!STAT_FIELDS.has(stat)) {
        throw new ValueError(`${path}: 不认识的数值字段 ${record.stat}`);
      }
      return { kind: 'agg', op, of, stat };
    }
    case 'event': {
      const which = String(record.event).toLowerCase();
      if (which !== 'value' && which !== 'lethal') {
        throw new ValueError(`${path}.event 只能是 value / lethal`);
      }
      return { kind: 'event', key: which };
    }
    case 'turn':
      return { kind: 'turn' };
    case 'random':
      return { kind: 'random' };
    case 'if': {
      if (record.then === undefined) {
        throw new ValueError(`${path}.if 需要配 then`);
      }
      const condition = normalizeCondition(record.if, `${path}.if`);
      const then_branch = next(record.then, 'then');
      const else_branch = record.else === undefined ? null : next(record.else, 'else');
      return { kind: 'if', condition, then: then_branch, else: else_branch };
    }
    default:
      throw new ValueError(`${path}: 不认识的表达式键 ${key}`);
  }
}

// ---------------------------------------------------------------------------
// 规范化 (把机读区里的所有数值字段都编译成 AST)
// ---------------------------------------------------------------------------

/** 条件里哪些字段是「数值」 */
const CONDITION_NUMBER_FIELDS: Record<string, readonly string[]> = {
  count: ['value'],
  self: ['hp_below', 'hp_percent_below', 'atk_above', 'turns_in_zone', 'value'],
  event: ['value_above', 'value_below'],
  player: ['hp_below', 'hp_percent_below', 'value'],
  flag: ['value'],
  var: ['value'],
  target: ['hp_below', 'hp_percent_below', 'atk_above', 'turns_in_zone', 'value', 'count_value'],
};

/** 就地编译一个条件里的数值字段 (返回同一个对象) */
export function normalizeCondition(raw: unknown, path = 'condition'): Condition {
  if (typeof raw !== 'object' || raw === null) {
    return raw as Condition;
  }
  const cond = raw as Record<string, unknown>;

  if (Array.isArray(cond.all)) {
    cond.all = (cond.all as unknown[]).map((item, index) => normalizeCondition(item, `${path}.all[${index}]`));
    return cond as unknown as Condition;
  }
  if (Array.isArray(cond.any)) {
    cond.any = (cond.any as unknown[]).map((item, index) => normalizeCondition(item, `${path}.any[${index}]`));
    return cond as unknown as Condition;
  }
  if (cond.not !== undefined) {
    cond.not = normalizeCondition(cond.not, `${path}.not`);
    return cond as unknown as Condition;
  }

  // `{ count/flag/var: ..., op, value }` 这几个叶子的数值直接在条件对象上
  if (cond.value !== undefined) {
    cond.value = compileValue(cond.value, `${path}.value`);
  }

  const leaf = Object.keys(cond).find(key => CONDITION_NUMBER_FIELDS[key] !== undefined);
  if (!leaf) {
    return cond as unknown as Condition;
  }
  const inner = cond[leaf] as Record<string, unknown>;
  if (typeof inner !== 'object' || inner === null) {
    return cond as unknown as Condition;
  }
  for (const field of CONDITION_NUMBER_FIELDS[leaf]) {
    if (inner[field] !== undefined) {
      inner[field] = compileValue(inner[field], `${path}.${leaf}.${field}`);
    }
  }
  return cond as unknown as Condition;
}

/** 就地编译一条修正的数值 */
export function normalizeModifier(spec: ModifierSpec, path = 'modifiers[]'): ModifierSpec {
  if (spec.value !== undefined) {
    spec.value = compileValue(spec.value, `${path}.value`);
  }
  if (spec.condition) {
    spec.condition = normalizeCondition(spec.condition, `${path}.condition`);
  }
  return spec;
}

/** 某些操作必须写全的字段 (保存卡牌时就挡住, 不用等到结算那一刻) */
const OPERATION_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  IF: ['condition', 'then'],
  FOR_EACH: ['target', 'operations'],
  REPEAT: ['times', 'operations'],
  SET_VAR: ['var'],
  ADD_VAR: ['var'],
};

/** 就地编译一个操作 (含嵌套的操作数组与效果) */
export function normalizeOperation(spec: OperationSpec, path = 'operations[]'): OperationSpec {
  const type = String(spec.type ?? '');
  if (!type) {
    throw new ValueError(`${path} 缺少 type`);
  }
  if (!hasOperation(type)) {
    throw new ValueError(`${path}: 未知操作 ${type}`);
  }

  const fields = spec as unknown as Record<string, unknown>;
  for (const field of OPERATION_REQUIRED_FIELDS[type] ?? []) {
    if (fields[field] === undefined) {
      throw new ValueError(`${path}: ${type} 缺少 ${field}`);
    }
  }

  if (spec.value !== undefined) {
    spec.value = compileValue(spec.value, `${path}.value`);
  }
  if (spec.times !== undefined) {
    spec.times = compileValue(spec.times, `${path}.times`);
  }
  if (spec.condition) {
    spec.condition = normalizeCondition(spec.condition, `${path}.condition`);
  }
  if (spec.break_if) {
    spec.break_if = normalizeCondition(spec.break_if, `${path}.break_if`);
  }
  if (spec.then && !Array.isArray(spec.then)) {
    throw new ValueError(`${path}: then 要写成操作数组`);
  }
  if (spec.else && !Array.isArray(spec.else)) {
    throw new ValueError(`${path}: else 要写成操作数组`);
  }
  if (spec.operations && !Array.isArray(spec.operations)) {
    throw new ValueError(`${path}: operations 要写成操作数组`);
  }

  if (spec.then) {
    spec.then = spec.then.map((item, index) => normalizeOperation(item, `${path}.then[${index}]`));
  }
  if (spec.else) {
    spec.else = spec.else.map((item, index) => normalizeOperation(item, `${path}.else[${index}]`));
  }
  if (spec.operations) {
    spec.operations = spec.operations.map((item, index) => normalizeOperation(item, `${path}.operations[${index}]`));
  }

  if (spec.effects) {
    spec.effects = spec.effects.map((effect, index) => normalizeEffect(effect, `${path}.effects[${index}]`));
  }
  if (spec.modifiers) {
    spec.modifiers = spec.modifiers.map((item, index) => normalizeModifier(item, `${path}.modifiers[${index}]`));
  }

  return spec;
}

/** 就地编译一条效果 (校验通过后的最后一步) */
export function normalizeEffect(def: EffectDefinition, path = 'effects[]'): EffectDefinition {
  if (def.condition) {
    def.condition = normalizeCondition(def.condition, `${path}.condition`);
  }
  if (def.cost) {
    def.cost = def.cost.map((item, index) => normalizeOperation(item, `${path}.cost[${index}]`));
  }
  if (def.operations) {
    def.operations = def.operations.map((item, index) => normalizeOperation(item, `${path}.operations[${index}]`));
  }
  if (def.modifiers) {
    def.modifiers = def.modifiers.map((item, index) => normalizeModifier(item, `${path}.modifiers[${index}]`));
  }
  return def;
}

// ---------------------------------------------------------------------------
// 展示 (错误信息 / 调试面板用)
// ---------------------------------------------------------------------------

/** 把 AST 还原成一行公式 (只用于展示, 不保证能被重新解析) */
export function formatValue(expr: NumberSpec | undefined): string {
  if (expr === undefined) {
    return '';
  }
  if (typeof expr === 'number') {
    return String(expr);
  }
  switch (expr.kind) {
    case 'const':
      return String(expr.value);
    case 'op':
      return `${expr.op}(${expr.args.map(formatValue).join(', ')})`;
    case 'stat':
      return `${String(expr.of)}.${expr.stat}`;
    case 'var':
      return `$${expr.name}`;
    case 'agg':
      return `${expr.op}(${String(expr.of)}, ${expr.stat})`;
    case 'event':
      return `EVENT.${expr.key}`;
    case 'turn':
      return 'TURN';
    case 'random':
      return 'RANDOM()';
    case 'if':
      return `IF(?, ${formatValue(expr.then)}, ${expr.else ? formatValue(expr.else) : '0'})`;
  }
}

/** 目标条件里的数值字段 (供调试展示) */
export function isTargetCondition(cond: Condition): cond is { target: TargetCondition } {
  return typeof cond === 'object' && cond !== null && 'target' in cond;
}
