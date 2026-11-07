import {
  ConfigService,
  ConnectionPool,
  ConnectionPoolRegistry,
  LegacyOrderRepository,
  OrderRepository,
  config,
} from './singleton';

console.log('\n1. Classic lazy singleton: ConnectionPoolRegistry.getInstance()');
console.log('   registries built before the first call:', ConnectionPoolRegistry.instancesCreated);
const fromCheckout = ConnectionPoolRegistry.getInstance();
const fromReports = ConnectionPoolRegistry.getInstance();
console.log('   same instance?', fromCheckout === fromReports, '| registries built:', ConnectionPoolRegistry.instancesCreated);

console.log('\n2. Shared state: checkout and reports both ask for the "orders" pool');
const checkoutPool = fromCheckout.pool('orders', { maxConnections: 2 });
const reportsPool = fromReports.pool('orders');
checkoutPool.acquire();
reportsPool.acquire();
console.log('   same pool?', checkoutPool === reportsPool, `| in use: ${reportsPool.inUse} of ${reportsPool.options.maxConnections}`);
try {
  fromCheckout.pool('orders').acquire();
} catch (error) {
  console.log('   a third acquire ->', (error as Error).message);
}

console.log('\n3. Module-scope singleton: export const config = new ConfigService(process.env)');
const secondImport = await import('./singleton');
config.override('FEATURE_FAST_CHECKOUT', 'on');
console.log('   second import, same object?', secondImport.config === config);
console.log('   override made through one import, read through the other:', secondImport.config.get('FEATURE_FAST_CHECKOUT'));

console.log('\n4. Why getInstance() hurts testing');
ConnectionPoolRegistry.resetForTests(); // the hook every classic singleton grows
config.override('ORDERS_DB_POOL', 'orders-legacy');
const legacyRow = new LegacyOrderRepository().findById('ord_1');
console.log(`   legacy repo served by ${legacyRow.servedBy}: steerable only by mutating two globals`);
config.clearOverrides();

console.log('\n5. Dependency injection: decide "one instance" in main(), pass it in');
const testWired = new OrderRepository(new ConfigService({ ORDERS_DB_POOL: 'orders-replica' }), {
  pool: (name) => new ConnectionPool(name, { maxConnections: 1 }),
});
console.log('   test wiring  ->', testWired.findById('ord_2').servedBy, '(fresh instances, no globals touched)');
const prodWired = new OrderRepository(config, ConnectionPoolRegistry.getInstance());
console.log('   prod wiring  ->', prodWired.findById('ord_3').servedBy, '(the shared registry, injected once)');
console.log('   shared registry now holds:', ConnectionPoolRegistry.getInstance().names(), '(step 4 left its pool behind)');
console.log();
