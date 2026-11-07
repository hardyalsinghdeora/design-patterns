import { Rule, RuleEvaluationError, RuleSyntaxError, eligibleOffers, tokenize } from './interpreter';

const source = "cart_total >= 100000 AND (country = 'IN' OR tier = 'gold')";
console.log(`\nRule: ${source}`);
console.log('Tokens:', tokenize(source).map((t) => t.text || '<eof>').join(' | '));

const rule = Rule.parse(source);
console.log('AST  :', rule.ast.toString(), '(parentheses show how it was grouped)');

const carts = [
  { cart_total: 1_20_000, country: 'IN', tier: 'silver' },
  { cart_total: 1_20_000, country: 'US', tier: 'silver' },
  { cart_total: 1_20_000, country: 'US', tier: 'gold' },
  { cart_total: 50_000, country: 'IN', tier: 'gold' },
];
console.log('\nOne parse, many evaluations:');
for (const ctx of carts) console.log(`  ${JSON.stringify(ctx).padEnd(55)} -> ${rule.matches(ctx)}`);

console.log('\nPrecedence: without parentheses AND binds first');
const loose = Rule.parse("cart_total >= 100000 AND country = 'IN' OR tier = 'gold'");
console.log('  ', loose.ast.toString(), '->', loose.matches(carts[3]!));

console.log('\nErrors carry positions:');
for (const bad of ['cart_total > ', "(tier = 'gold'", 'tier = gold #vip']) {
  try {
    Rule.parse(bad);
  } catch (err) {
    if (err instanceof RuleSyntaxError) console.log(`  ${err.message}\n  ${err.pointer().replace('\n', '\n  ')}`);
  }
}
try {
  rule.matches({ cart_total: 1_20_000, country: 'US' });
} catch (err) {
  if (err instanceof RuleEvaluationError) console.log(`  ${err.message}`);
}

console.log('\nSame interpreter, rules built as JSON by an admin UI:');
const offers = [
  { code: 'BIG10', rule: Rule.fromJson({ all: [{ var: 'cart_total', op: '>=', value: 100_000 }, { not: { var: 'country', op: '=', value: 'US' } }] }) },
  { code: 'GOLD5', rule: Rule.parse("tier = 'gold'") },
];
for (const offer of offers) console.log(`  ${offer.code}: ${offer.rule.source}`);
for (const ctx of carts) console.log(`  ${JSON.stringify(ctx).padEnd(55)} -> [${eligibleOffers(offers, ctx).join(', ')}]`);
console.log();
