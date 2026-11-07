import { describe, expect, it } from 'vitest';
import { Rule, RuleEvaluationError, RuleSyntaxError, UnknownVariableError, eligibleOffers, tokenize } from './interpreter';

const syntaxError = (source: string): RuleSyntaxError => {
  try {
    Rule.parse(source);
  } catch (err) {
    if (err instanceof RuleSyntaxError) return err;
    throw err;
  }
  throw new Error(`expected "${source}" to fail`);
};

const usGold = { cart_total: 50_000, country: 'US', tier: 'gold' };

describe('tokenizer and parser', () => {
  it('tokenizes with positions and reads two-character operators first', () => {
    expect(tokenize("cart_total >= 100 AND tier != 'gold'").map((t) => `${t.type}@${t.position}`)).toEqual([
      'identifier@0', 'op@11', 'number@14', 'and@18', 'identifier@22', 'op@27', 'string@30', 'eof@36',
    ]);
  });

  it('AND binds tighter than OR', () => {
    const rule = Rule.parse("cart_total >= 100000 AND country = 'IN' OR tier = 'gold'");
    expect(rule.ast.toString()).toBe("((cart_total >= 100000 AND country = 'IN') OR tier = 'gold')");
    expect(rule.matches(usGold)).toBe(true); // gold alone is enough
  });

  it('parentheses override precedence', () => {
    const rule = Rule.parse("cart_total >= 100000 AND (country = 'IN' OR tier = 'gold')");
    expect(rule.ast.toString()).toBe("(cart_total >= 100000 AND (country = 'IN' OR tier = 'gold'))");
    expect(rule.matches(usGold)).toBe(false); // cart too small
    expect(rule.matches({ ...usGold, cart_total: 150_000 })).toBe(true);
  });

  it('NOT applies to the comparison that follows and can be nested', () => {
    expect(Rule.parse("NOT tier = 'gold'").matches(usGold)).toBe(false);
    expect(Rule.parse('not not beta_user').matches({ beta_user: true })).toBe(true);
    expect(Rule.parse("NOT (country = 'IN' OR country = 'US')").matches(usGold)).toBe(false);
  });

  it('reports syntax errors with the position of the offending token', () => {
    expect(syntaxError('cart_total > ').message).toBe('Expected a value but found end of input at position 13');
    expect(syntaxError("(tier = 'gold'").message).toBe('Expected ")" but found end of input at position 14');
    expect(syntaxError('cart_total > > 5').position).toBe(13);
    expect(syntaxError("country = 'IN").message).toBe('Unterminated string at position 10');
    const err = syntaxError('tier = gold #vip');
    expect(err.message).toBe('Unexpected character "#" at position 12');
    expect(err.pointer()).toBe('tier = gold #vip\n            ^');
  });
});

describe('evaluation', () => {
  const rule = Rule.parse("cart_total >= 100000 AND (country = 'IN' OR tier = 'gold') AND NOT blocked");

  it('evaluates the same AST against many contexts', () => {
    const base = { cart_total: 120_000, country: 'IN', tier: 'silver', blocked: false };
    expect(rule.matches(base)).toBe(true);
    expect(rule.matches({ ...base, country: 'US' })).toBe(false);
    expect(rule.matches({ ...base, country: 'US', tier: 'gold' })).toBe(true);
    expect(rule.matches({ ...base, blocked: true })).toBe(false);
    expect(rule.matches({ ...base, cart_total: 99_999 })).toBe(false);
  });

  it('throws UnknownVariableError with the name and position, and short-circuits past it', () => {
    expect(() => rule.matches({ cart_total: 120_000, country: 'IN' })).toThrow(new UnknownVariableError('blocked', 67));
    // Short-circuit: the left side is false, so `tier` is never looked up.
    expect(Rule.parse("cart_total > 1 AND tier = 'gold'").matches({ cart_total: 0 })).toBe(false);
    expect(() => Rule.parse("tier = 'gold'").matches({ constructor: 'x' })).toThrow(UnknownVariableError);
    expect(() => Rule.parse('cart_totl > 5', { knownVariables: ['cart_total'] })).toThrow('Unknown variable "cart_totl" at position 0');
  });

  it('rejects type mismatches instead of silently returning false', () => {
    expect(() => Rule.parse('country > 5').matches(usGold)).toThrow(new RuleEvaluationError('Cannot compare string with number', 8));
    expect(() => Rule.parse('cart_total').matches(usGold)).toThrow(/must evaluate to true or false/);
  });

  it('JSON rules build the same AST without a parser', () => {
    const json = Rule.fromJson({
      all: [
        { var: 'cart_total', op: '>=', value: 100_000 },
        { any: [{ var: 'country', op: '=', value: 'IN' }, { var: 'tier', op: '=', value: 'gold' }] },
      ],
    });
    const text = Rule.parse("cart_total >= 100000 AND (country = 'IN' OR tier = 'gold')");
    expect(json.source).toBe(text.ast.toString());
    const offers = [{ code: 'BIG10', rule: json }, { code: 'GOLD5', rule: Rule.parse("tier = 'gold'") }];
    expect(eligibleOffers(offers, usGold)).toEqual(['GOLD5']);
    expect(eligibleOffers(offers, { ...usGold, cart_total: 200_000 })).toEqual(['BIG10', 'GOLD5']);
  });
});
