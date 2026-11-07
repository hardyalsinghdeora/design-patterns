import { ConnectionPool, FakeConnectionFactory, ManualClock, PoolTimeoutError } from './object-pool';

const clock = new ManualClock(0);
const factory = new FakeConnectionFactory();
const pool = new ConnectionPool(factory, { min: 2, max: 3, maxWaitMs: 500, leakThresholdMs: 10_000, clock });

await pool.warmUp();
console.log('\nWarmed up:', pool.stats());

console.log('\n1) Twenty requests, one after another, each borrowing a connection:');
for (let i = 1; i <= 20; i++) {
  await pool.withConnection((conn) => conn.query(`SELECT * FROM invoices WHERE id = ${i}`), `req-${i}`);
}
console.log(`   20 queries, ${factory.created} handshakes (without a pool: 20)`);

console.log('\n2) A burst of five concurrent requests against max = 3:');
const leases = await Promise.all([pool.acquire('a'), pool.acquire('b'), pool.acquire('c')]);
const late = [pool.acquire('d'), pool.acquire('e')];
console.log('  ', pool.stats(), '(d and e are queued)');
pool.release(leases[0]);
const d = await late[0];
console.log(`   a released -> d got ${d.id} (FIFO hand-off)`);

console.log('\n3) e waits past maxWaitMs on the injected clock:');
clock.advance(500);
pool.sweep();
await late[1].catch((err: unknown) => console.log('  ', err instanceof PoolTimeoutError ? err.message : err));

console.log('\n4) b breaks mid-request; on release it is destroyed, not reused:');
leases[1].breakConnection();
pool.release(leases[1]);
console.log('  ', pool.stats());

console.log('\n5) Leak detection: c and d are still out after 11 s');
clock.advance(11_000);
for (const leak of pool.sweep().leaks) console.log(`   ${leak.connectionId} held by ${leak.holder} for ${leak.heldMs} ms`);

pool.release(leases[2]);
pool.release(d);
await pool.warmUp();
console.log('\nAfter releasing and warming up again:', pool.stats(), `handshakes: ${factory.created}`);
pool.close();
console.log();
