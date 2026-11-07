import { describe, expect, it } from 'vitest';
import {
  NotificationTemplate,
  PricingPlan,
  PrototypeRegistry,
  ReportConfig,
  deepCopy,
  jsonCopy,
  notificationPresets,
  pricingPresets,
  reportPresets,
  shallowCopy,
} from './prototype';

const period = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-31T23:59:59Z') };
const report = () => reportPresets(period).create('monthly-revenue');

describe('cloning prototypes', () => {
  it('a cloned notification template is independent of the original', () => {
    const original = new NotificationTemplate('email', 'Hi {{name}}', 'Order {{orderId}}', ['transactional'], { name: 'there' });
    const copy = original.clone();
    copy.subject = 'Hello {{name}}';
    copy.tags.push('vip');
    copy.defaults.name = 'friend';
    expect(original.tags).toEqual(['transactional']);
    expect(original.render({ orderId: 'o1' })).toEqual({ subject: 'Hi there', body: 'Order o1' });
    expect(copy.render({ orderId: 'o1' }).subject).toBe('Hello friend');
  });

  it('shallow copy leaks nested changes into the original (the bug)', () => {
    const original = report();
    const copy = shallowCopy(original.data);
    copy.name = 'APAC';
    copy.filters.regions.push('AU');
    copy.delivery.schedule.timezone = 'Australia/Sydney';
    expect(original.data.name).toBe('Monthly revenue'); // top level is fine...
    expect(original.data.filters.regions).toEqual(['IN', 'SG', 'AU']); // ...nested is shared
    expect(original.data.delivery.schedule.timezone).toBe('Australia/Sydney');
  });

  it('deep copy keeps deeply nested objects independent (the fix)', () => {
    const original = report();
    const copy = original.clone();
    copy.data.filters.regions.push('AU');
    copy.data.columns[0].label = 'Invoice #';
    copy.data.delivery.recipients.push('ceo@acme.example');
    copy.data.filters.period.from.setUTCDate(15);
    expect(copy).toBeInstanceOf(ReportConfig);
    expect(original.data.filters.regions).toEqual(['IN', 'SG']);
    expect(original.data.columns[0].label).toBe('Invoice');
    expect(original.data.delivery.recipients).toEqual(['finance@acme.example']);
    expect(original.data.filters.period.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('Date and Map fields survive structuredClone but not JSON', () => {
    const data = report().data;
    const deep = deepCopy(data);
    expect(deep.filters.period.to).toBeInstanceOf(Date);
    expect(deep.filters.period.to.getTime()).toBe(data.filters.period.to.getTime());
    expect(deep.thresholds).toBeInstanceOf(Map);
    expect(deep.thresholds.get('refund_rate_bp')).toBe(250);
    expect(deep.thresholds).not.toBe(data.thresholds);

    const viaJson = jsonCopy(data);
    expect(typeof viaJson.filters.period.to).toBe('string');
    expect(viaJson.thresholds).not.toBeInstanceOf(Map);
  });

  it('pricing plans copy Set, Map and Date, and keep their class', () => {
    const pro = pricingPresets(new Date('2026-11-01T00:00:00Z')).create('pro');
    const festive = pro.variant('Pro (festive)', 20);
    festive.features.add('priority-support');
    festive.limits.set('seats', 20);
    festive.validFrom.setUTCMonth(11);
    expect(festive.monthlyPriceMinor).toBe(3_99_920);
    expect([pro.allows('priority-support'), pro.limit('seats'), pro.validFrom.getUTCMonth()]).toEqual([false, 10, 10]);
    expect(festive).toBeInstanceOf(PricingPlan);
    // structuredClone on a class instance copies the fields but drops the prototype: that is why clone() exists.
    expect(structuredClone(pro)).not.toBeInstanceOf(PricingPlan);
  });
});

describe('PrototypeRegistry', () => {
  it('returns a fresh copy on every create, so customising one never affects the next', () => {
    const registry = notificationPresets();
    const first = registry.create('order-shipped', (t) => t.tags.push('vip'));
    const second = registry.create('order-shipped');
    expect(first).not.toBe(second);
    expect(first.tags).toEqual(['transactional', 'vip']);
    expect(second.tags).toEqual(['transactional']);
  });

  it('stores its own copy at registration time', () => {
    const plan = new PricingPlan('Team', 1_99_900, 'INR', new Set(['invoices']), new Map([['seats', 5]]), new Date('2026-11-01T00:00:00Z'));
    const registry = new PrototypeRegistry<PricingPlan>().register('team', plan);
    plan.monthlyPriceMinor = 1;
    plan.features.add('everything');
    const created = registry.create('team');
    expect([created.monthlyPriceMinor, created.allows('everything')]).toEqual([1_99_900, false]);
  });

  it('lists names and rejects unknown ones', () => {
    const registry = pricingPresets(new Date('2026-11-01T00:00:00Z'));
    expect(registry.names()).toEqual(['pro', 'starter']);
    expect(registry.has('enterprise')).toBe(false);
    expect(() => registry.create('enterprise')).toThrow('No prototype named "enterprise". Registered: pro, starter');
  });
});
