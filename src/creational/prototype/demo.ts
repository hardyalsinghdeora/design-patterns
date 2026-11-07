import { deepCopy, jsonCopy, notificationPresets, pricingPresets, reportPresets, shallowCopy } from './prototype';

const period = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-31T23:59:59Z') };

console.log('\n1. Notification templates from a registry, customised per use:');
const templates = notificationPresets();
const vip = templates.create('order-shipped', (t) => {
  t.subject = `[VIP] ${t.subject}`;
  t.tags.push('vip');
});
console.log('  vip copy   :', vip.render({ orderId: 'ord_42', trackingUrl: 'https://track.example/42' }).subject, vip.tags);
console.log('  next create:', templates.create('order-shipped').subject, templates.create('order-shipped').tags);

console.log('\n2. The shallow-copy bug on a nested report config:');
const preset = reportPresets(period).create('monthly-revenue');
const shallow = shallowCopy(preset.data);
shallow.name = 'APAC revenue';
shallow.filters.regions.push('AU'); // looks local, is not
shallow.delivery.schedule.timezone = 'Australia/Sydney';
console.log('  original name    :', preset.data.name, '(top level was copied)');
console.log('  original regions :', preset.data.filters.regions, '<- leaked');
console.log('  original timezone:', preset.data.delivery.schedule.timezone, '<- leaked');

console.log('\n3. The fix: structuredClone');
const fresh = reportPresets(period).create('monthly-revenue');
const deep = deepCopy(fresh.data);
deep.filters.regions.push('AU');
deep.thresholds.set('refund_rate_bp', 100);
console.log('  original regions  :', fresh.data.filters.regions);
console.log('  original threshold:', fresh.data.thresholds.get('refund_rate_bp'));
console.log('  copy still has a Date and a Map:', deep.filters.period.from instanceof Date, deep.thresholds instanceof Map);
const viaJson = jsonCopy(fresh.data);
console.log('  JSON copy instead :', typeof viaJson.filters.period.from, viaJson.thresholds instanceof Map ? 'Map' : JSON.stringify(viaJson.thresholds));

console.log('\n4. Pricing presets and a promotional variant:');
const plans = pricingPresets(new Date('2026-11-01T00:00:00Z'));
const pro = plans.create('pro');
const festive = pro.variant('Pro (Diwali)', 20);
festive.features.add('priority-support');
console.log(`  ${pro.name}: ${pro.monthlyPriceMinor} paise, priority-support=${pro.allows('priority-support')}`);
console.log(`  ${festive.name}: ${festive.monthlyPriceMinor} paise, priority-support=${festive.allows('priority-support')}`);
console.log('  report:', reportPresets(period).create('monthly-revenue').describe());
console.log();
