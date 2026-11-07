import {
  AnonymousCustomer,
  CheckoutService,
  CustomerDirectory,
  InMemoryMetrics,
  MapCache,
  MemoryLogger,
  NoopMetrics,
  NullCache,
  NullLogger,
  PriceCatalog,
  PricingService,
  RegisteredCustomer,
  wiringReport,
} from './null-object';

const prices = { 'sku-kbd': 2_499_00, 'sku-mouse': 999_00 };
const asha = new RegisteredCustomer('cus_1', 'Asha', ['orders:create', 'credit:use'], 'gold');
const directory = new CustomerDirectory(new Map([['tok_asha', asha]]));

console.log('\n1) Production wiring: real logger, metrics and cache');
const logger = new MemoryLogger();
const metrics = new InMemoryMetrics();
const prodCatalog = new PriceCatalog(prices);
const prod = new CheckoutService(new PricingService(prodCatalog, logger, metrics, new MapCache<number>()), logger);
for (const token of ['tok_asha', undefined, 'tok_expired']) {
  const customer = directory.resolve(token);
  console.log(`  token ${String(token).padEnd(11)} -> ${customer.displayName.padEnd(5)} ${prod.checkout(customer, 'sku-kbd', 1).message}`);
}
console.log('  guest + store credit ->', prod.checkout(AnonymousCustomer.instance, 'sku-kbd', 1, true).message);
console.log('  log lines:', logger.lines.length, '| cache misses:', metrics.counter('price.cache_miss'), '| catalog lookups:', prodCatalog.lookups);

console.log('\n2) Unit-test or script wiring: null objects, same service code, no if (logger) anywhere');
const quietCatalog = new PriceCatalog(prices);
const quiet = new CheckoutService(new PricingService(quietCatalog));
console.log('  Asha  ->', quiet.checkout(asha, 'sku-kbd', 1).message);
console.log('  Guest ->', quiet.checkout(directory.resolve(undefined), 'sku-kbd', 1).message);
console.log('  catalog lookups with NullCache:', quietCatalog.lookups, '(every call misses, still correct)');

console.log('\n3) The startup wiring report makes silent null objects visible:');
for (const line of wiringReport({ logger: NullLogger.instance, metrics: NoopMetrics.instance, cache: new NullCache<number>() })) {
  console.log('  WARN', line);
}

console.log('\n4) Not everything gets a null object: an unknown SKU must fail loudly');
try {
  quiet.checkout(asha, 'sku-ghost', 1);
} catch (err) {
  console.log('  ', (err as Error).message);
}
console.log();
