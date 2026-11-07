/**
 * INTERPRETER
 * Represent each grammar rule of a small language as a class and evaluate a sentence
 * by building a tree of those classes (an AST) and calling evaluate(context) on its root.
 *
 * Example domain: discount and feature-flag eligibility rules written by ops, e.g.
 *   cart_total >= 100000 AND (country = 'IN' OR tier = 'gold')
 * Money values in rules are integers in minor units (paise).
 */

export type Value = number | string | boolean;
export type Context = Readonly<Record<string, Value>>;
export type ComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=';

/* --------------------------------- Errors --------------------------------- */

const at = (position: number | undefined) => (position === undefined ? '' : ` at position ${position}`);

/** Thrown while tokenizing or parsing. Positions are 0-based offsets into the source. */
export class RuleSyntaxError extends Error {
  override readonly name = 'RuleSyntaxError';
  constructor(
    readonly reason: string,
    readonly position: number,
    readonly source: string,
  ) {
    super(`${reason}${at(position)}`);
  }

  /** Two-line caret pointer, handy for rule-editor UIs and 400 responses. */
  pointer(): string {
    return `${this.source}\n${' '.repeat(this.position)}^`;
  }
}

export class RuleEvaluationError extends Error {
  override readonly name: string = 'RuleEvaluationError';
  constructor(
    readonly reason: string,
    readonly position?: number,
  ) {
    super(`${reason}${at(position)}`);
  }
}

export class UnknownVariableError extends RuleEvaluationError {
  override readonly name = 'UnknownVariableError';
  constructor(
    readonly variable: string,
    position?: number,
  ) {
    super(`Unknown variable "${variable}"`, position);
  }
}

/* ------------------------------- AST classes ------------------------------ */

/** The abstract expression. Every node knows how to evaluate itself against a context. */
export interface Expression {
  readonly position?: number;
  evaluate(context: Context): Value;
  variables(): Variable[];
  toString(): string;
}

function asBoolean(value: Value, operator: string, position: number | undefined): boolean {
  if (typeof value !== 'boolean') throw new RuleEvaluationError(`${operator} expects true/false, got ${typeof value}`, position);
  return value;
}

/** Terminal expression: a constant. */
export class Literal implements Expression {
  constructor(
    readonly value: Value,
    readonly position?: number,
  ) {}
  evaluate(): Value {
    return this.value;
  }
  variables(): Variable[] {
    return [];
  }
  toString(): string {
    return typeof this.value === 'string' ? `'${this.value}'` : String(this.value);
  }
}

/** Terminal expression: looks a name up in the context. */
export class Variable implements Expression {
  constructor(
    readonly name: string,
    readonly position?: number,
  ) {}
  evaluate(context: Context): Value {
    // hasOwn, not `in`: a rule must never reach Object.prototype ("constructor", "toString").
    if (!Object.hasOwn(context, this.name)) throw new UnknownVariableError(this.name, this.position);
    return context[this.name] as Value;
  }
  variables(): Variable[] {
    return [this];
  }
  toString(): string {
    return this.name;
  }
}

export class Comparison implements Expression {
  constructor(
    readonly operator: ComparisonOperator,
    readonly left: Expression,
    readonly right: Expression,
    readonly position?: number,
  ) {}

  evaluate(context: Context): Value {
    const l = this.left.evaluate(context);
    const r = this.right.evaluate(context);
    // Strict typing on purpose: `tier = 5` or `country > 3` is a rule bug, not "false".
    if (typeof l !== typeof r) throw new RuleEvaluationError(`Cannot compare ${typeof l} with ${typeof r}`, this.position);
    if (this.operator === '=') return l === r;
    if (this.operator === '!=') return l !== r;
    if (typeof l !== 'number' || typeof r !== 'number') {
      throw new RuleEvaluationError(`"${this.operator}" needs numbers, got ${typeof l}`, this.position);
    }
    switch (this.operator) {
      case '>':
        return l > r;
      case '>=':
        return l >= r;
      case '<':
        return l < r;
      case '<=':
        return l <= r;
    }
  }
  variables(): Variable[] {
    return [...this.left.variables(), ...this.right.variables()];
  }
  toString(): string {
    return `${this.left} ${this.operator} ${this.right}`;
  }
}

/** Non-terminal expressions. AND/OR short-circuit, so `has_card AND card_tier = 'gold'` is safe. */
export class And implements Expression {
  constructor(
    readonly left: Expression,
    readonly right: Expression,
    readonly position?: number,
  ) {}
  evaluate(context: Context): Value {
    return asBoolean(this.left.evaluate(context), 'AND', this.position) && asBoolean(this.right.evaluate(context), 'AND', this.position);
  }
  variables(): Variable[] {
    return [...this.left.variables(), ...this.right.variables()];
  }
  toString(): string {
    return `(${this.left} AND ${this.right})`;
  }
}

export class Or implements Expression {
  constructor(
    readonly left: Expression,
    readonly right: Expression,
    readonly position?: number,
  ) {}
  evaluate(context: Context): Value {
    return asBoolean(this.left.evaluate(context), 'OR', this.position) || asBoolean(this.right.evaluate(context), 'OR', this.position);
  }
  variables(): Variable[] {
    return [...this.left.variables(), ...this.right.variables()];
  }
  toString(): string {
    return `(${this.left} OR ${this.right})`;
  }
}

export class Not implements Expression {
  constructor(
    readonly operand: Expression,
    readonly position?: number,
  ) {}
  evaluate(context: Context): Value {
    return !asBoolean(this.operand.evaluate(context), 'NOT', this.position);
  }
  variables(): Variable[] {
    return this.operand.variables();
  }
  toString(): string {
    return `NOT ${this.operand}`;
  }
}

/* -------------------------------- Tokenizer ------------------------------- */

export type TokenType = 'number' | 'string' | 'identifier' | 'and' | 'or' | 'not' | 'true' | 'false' | 'op' | 'lparen' | 'rparen' | 'eof';

export interface Token {
  type: TokenType;
  text: string;
  position: number;
}

const KEYWORDS: Partial<Record<string, TokenType>> = { AND: 'and', OR: 'or', NOT: 'not', TRUE: 'true', FALSE: 'false' };
// Longest first, so ">=" is not read as ">" followed by "=".
const OPERATORS: readonly ComparisonOperator[] = ['>=', '<=', '!=', '=', '>', '<'];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const readWhile = (start: number, re: RegExp) => {
    let end = start;
    while (end < source.length && re.test(source.charAt(end))) end++;
    return end;
  };
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: ch === '(' ? 'lparen' : 'rparen', text: ch, position: i++ });
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      tokens.push({ type: 'op', text: op, position: i });
      i += op.length;
      continue;
    }
    if (/\d/.test(ch)) {
      const end = readWhile(i, /\d/);
      tokens.push({ type: 'number', text: source.slice(i, end), position: i });
      i = end;
      continue;
    }
    if (ch === "'") {
      const close = source.indexOf("'", i + 1);
      if (close === -1) throw new RuleSyntaxError('Unterminated string', i, source);
      tokens.push({ type: 'string', text: source.slice(i + 1, close), position: i });
      i = close + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const end = readWhile(i, /[A-Za-z0-9_.]/);
      const text = source.slice(i, end);
      tokens.push({ type: KEYWORDS[text.toUpperCase()] ?? 'identifier', text, position: i });
      i = end;
      continue;
    }
    throw new RuleSyntaxError(`Unexpected character "${ch}"`, i, source);
  }
  tokens.push({ type: 'eof', text: '', position: source.length });
  return tokens;
}

/* ------------------------- Recursive-descent parser ----------------------- */
/*   or         := and ( OR and )*                                           */
/*   and        := not ( AND not )*          AND binds tighter than OR        */
/*   not        := NOT not | comparison                                       */
/*   comparison := primary ( op primary )?                                    */
/*   primary    := '(' or ')' | number | string | true | false | identifier   */
/* One method per grammar rule; precedence falls out of which calls which.    */

export class Parser {
  private index = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  parse(): Expression {
    const expression = this.parseOr();
    this.expect('eof', 'end of input');
    return expression;
  }

  private parseOr(): Expression {
    let left = this.parseAnd();
    for (let op = this.match('or'); op; op = this.match('or')) left = new Or(left, this.parseAnd(), op.position);
    return left;
  }

  private parseAnd(): Expression {
    let left = this.parseNot();
    for (let op = this.match('and'); op; op = this.match('and')) left = new And(left, this.parseNot(), op.position);
    return left;
  }

  private parseNot(): Expression {
    const op = this.match('not');
    return op ? new Not(this.parseNot(), op.position) : this.parseComparison();
  }

  private parseComparison(): Expression {
    const left = this.parsePrimary();
    const op = this.match('op');
    if (!op) return left;
    return new Comparison(op.text as ComparisonOperator, left, this.parsePrimary(), op.position);
  }

  private parsePrimary(): Expression {
    const token = this.peek();
    switch (token.type) {
      case 'lparen': {
        this.index++;
        const inner = this.parseOr();
        this.expect('rparen', '")"');
        return inner;
      }
      case 'number':
        this.index++;
        return new Literal(Number(token.text), token.position);
      case 'string':
        this.index++;
        return new Literal(token.text, token.position);
      case 'true':
      case 'false':
        this.index++;
        return new Literal(token.type === 'true', token.position);
      case 'identifier':
        this.index++;
        return new Variable(token.text, token.position);
      default:
        throw this.error(`Expected a value but found ${describe(token)}`, token);
    }
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private match(type: TokenType): Token | undefined {
    const token = this.peek();
    if (token.type !== type) return undefined;
    this.index++;
    return token;
  }

  private expect(type: TokenType, what: string): Token {
    const token = this.match(type);
    if (!token) throw this.error(`Expected ${what} but found ${describe(this.peek())}`, this.peek());
    return token;
  }

  private error(reason: string, token: Token): RuleSyntaxError {
    return new RuleSyntaxError(reason, token.position, this.source);
  }
}

const describe = (t: Token) => (t.type === 'eof' ? 'end of input' : `"${t.text}"`);

/* --------------------------------- Client --------------------------------- */

export interface ParseOptions {
  /** Reject rules that mention unknown fields at save time, not at checkout time. */
  knownVariables?: readonly string[];
}

export class Rule {
  private constructor(
    readonly source: string,
    readonly ast: Expression,
  ) {}

  static parse(source: string, options: ParseOptions = {}): Rule {
    const ast = new Parser(tokenize(source), source).parse();
    if (options.knownVariables) {
      const known = new Set(options.knownVariables);
      const unknown = ast.variables().find((v) => !known.has(v.name));
      if (unknown) throw new UnknownVariableError(unknown.name, unknown.position);
    }
    return new Rule(source, ast);
  }

  static fromJson(rule: JsonRule): Rule {
    const ast = fromJson(rule);
    return new Rule(ast.toString(), ast);
  }

  matches(context: Context): boolean {
    const result = this.ast.evaluate(context);
    if (typeof result !== 'boolean') throw new RuleEvaluationError(`Rule must evaluate to true or false, got ${typeof result}`);
    return result;
  }
}

export interface Offer {
  code: string;
  rule: Rule;
}

/** Rules are parsed once when offers are loaded and evaluated per request. */
export function eligibleOffers(offers: readonly Offer[], context: Context): string[] {
  return offers.filter((offer) => offer.rule.matches(context)).map((offer) => offer.code);
}

/* ------------------------------------------------------------------------ */
/* JSON rules: when rules are built in an admin UI rather than typed, store  */
/* them as structured JSON and skip the tokenizer and parser entirely. The   */
/* same AST classes still do the evaluating.                                 */
/* ------------------------------------------------------------------------ */

export type JsonRule =
  | { all: JsonRule[] }
  | { any: JsonRule[] }
  | { not: JsonRule }
  | { var: string; op: ComparisonOperator; value: Value };

export function fromJson(rule: JsonRule): Expression {
  if ('all' in rule) return fold(rule.all, (l, r) => new And(l, r), true);
  if ('any' in rule) return fold(rule.any, (l, r) => new Or(l, r), false);
  if ('not' in rule) return new Not(fromJson(rule.not));
  return new Comparison(rule.op, new Variable(rule.var), new Literal(rule.value));
}

function fold(rules: JsonRule[], combine: (l: Expression, r: Expression) => Expression, empty: boolean): Expression {
  const [first, ...rest] = rules.map(fromJson);
  return first ? rest.reduce(combine, first) : new Literal(empty);
}
