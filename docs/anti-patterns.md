# Anti-patterns

An anti-pattern is a recurring solution that looks reasonable and costs more than it returns. Each entry gives the symptom you can spot in a code review, why it hurts, the refactoring that gets you out in small steps, and the pattern that helps. The pattern is the destination; the refactoring is the route.

| Anti-pattern | Spot it by | Way out |
|---|---|---|
| [God object](#god-object) | One class that every feature touches | Split by responsibility, behind a facade while you split |
| [Anemic domain model](#anemic-domain-model-and-when-it-is-fine) | Entities with only fields; rules in services | Move rules onto the entities, when there are rules |
| [Singleton abuse](#singleton-abuse) | `getInstance()` deep in business code | Dependency injection |
| [Service Locator](#service-locator) | `container.get(...)` inside methods | Constructor injection |
| [Golden hammer](#golden-hammer) | The same tool for every problem | Choose per problem; write the decision down |
| [Speculative generality](#speculative-generality-and-premature-abstraction) | Interfaces with one implementation, "just in case" | Inline it; wait for the rule of three |
| [Primitive obsession](#primitive-obsession-money-as-a-float) | `price: number`, money as a float | Value objects: `Money` in integer minor units |
| [Shotgun surgery](#shotgun-surgery) | One change, twelve files | Gather what changes together: Strategy, State |
| [Feature envy](#feature-envy) | Methods that mostly read another object's data | Move the method; tell, don't ask |
| [Leaky abstraction](#leaky-abstraction) | Callers catch the ORM's errors | Translate at the boundary: Adapter |
| [Distributed monolith](#distributed-monolith) | Services that must deploy together | One owner per piece of data; events; or merge back |
| [Chatty services](#chatty-services) | Fifty remote calls to serve one request | Batch, coarse-grained APIs, local read models |
| [Retry storms](#retry-storms) | Load triples while a dependency is failing | One retry layer, jittered backoff, budgets, Circuit Breaker |

## God object

- **Symptom:** `OrderService` has 3,000 lines, 15 constructor dependencies and a method for every feature. Every pull request touches it, and merge conflicts in it are routine.
- **Why it hurts:** unrelated features break each other; a unit test needs fifteen fakes; nobody can hold the class in their head, so changes are made by copying nearby code.
- **Refactoring:** extract classes along responsibilities (pricing, fulfilment, notifications), then move each behaviour next to the data it uses. Where it fits, split by use case: one handler per command. Keep the old class as a thin facade until its callers migrate.
- **Patterns that help:** [Facade](../src/structural/facade/README.md) during the split, [Command](../src/behavioral/command/README.md) handlers per use case, [Strategy](../src/behavioral/strategy/README.md) for the variations, [Observer](../src/behavioral/observer/README.md) to move side effects (emails, analytics) off the core path.

## Anemic domain model, and when it is fine

- **Symptom:** entities are bags of public fields, and every rule lives in services that assign to them (`order.status = 'paid'`). The same invariant is checked in some services and forgotten in others.
- **Why it hurts:** nothing guarantees an order is valid, because any code can assign any field. Rules are duplicated, and each copy drifts.
- **Refactoring:** make fields private and add intention-revealing methods (`order.applyDiscount(...)`, `order.markPaid(paymentId)`) that enforce the invariant in one place. Introduce value objects for money, email addresses and quantities.
- **Patterns that help:** [State](../src/behavioral/state/README.md) for lifecycle rules, [Specification](../src/modern/specification/README.md) for reusable rules, value objects.
- **When it is fine:** CRUD with no real rules; read models and DTOs (the query side of [CQRS](../src/modern/cqrs/README.md) is anemic on purpose); data crossing a process boundary. A transaction script per use case is a legitimate design for a simple domain. The anti-pattern is rich rules living away from the data they protect.

```ts
// Anemic: any caller can discount a paid order.
interface OrderRecord { status: 'draft' | 'paid'; totalMinor: number }

// Rich: the rule lives with the data it protects.
class Order {
  private constructor(private status: 'draft' | 'paid', private totalMinor: number) {}
  static draft(totalMinor: number): Order { return new Order('draft', totalMinor); }
  applyDiscount(discountMinor: number): void {
    if (this.status !== 'draft') throw new Error('only draft orders can be discounted');
    this.totalMinor = Math.max(0, this.totalMinor - discountMinor);
  }
}
```

## Singleton abuse

- **Symptom:** `Config.getInstance()`, `Logger.getInstance()` and `Db.getInstance()` are called from deep inside business code. Tests reset globals in `beforeEach` and fail when run in a different order.
- **Why it hurts:** dependencies are hidden, so a constructor signature lies about what the class needs. Global mutable state leaks between tests and between tenants. You cannot have two (a second database, a per-request logger), and initialisation order becomes implicit. In Node, two copies of the same package in `node_modules` quietly give you two "singletons".
- **Refactoring:** create each instance once at the composition root (`main.ts`) and pass it through constructors. "Only one" stays a lifetime decision made in that one place.
- **Patterns that help:** [Dependency Injection](../src/modern/dependency-injection/README.md). Keep [Singleton](../src/creational/singleton/README.md) for process-wide resources that are created once and reached only from the root.

## Service Locator

- **Symptom:** classes receive the container, or import a global one, and call `container.get<PaymentGateway>('PaymentGateway')` inside their methods.
- **Why it hurts:** the same hidden dependencies as Singleton abuse, plus a runtime failure instead of a compile error when a registration is missing. Every class now depends on the container, and every test must configure one.
- **Refactoring:** constructor injection, with a single `resolve` call at the composition root. When a class must create objects on demand, inject a factory function, not the container.
- **Patterns that help:** [Dependency Injection](../src/modern/dependency-injection/README.md), [Factory Method](../src/creational/factory-method/README.md) for on-demand creation. A locator is defensible in plugin hosts and framework glue, where the set of dependencies is only known at runtime.

## Golden hammer

- **Symptom:** one tool for every problem: every interaction is an event on Kafka, every class has a factory, every feature is a new microservice, and last month's pattern is suddenly in every file.
- **Why it hurts:** the tool fits some problems badly. A request/response flow forced through events loses its error path and its trace; a factory in front of every `new` is noise; a service per feature buys network failures without an independent scaling need.
- **Refactoring:** choose per problem, starting from the symptom, and record the decision with the alternative you rejected (an ADR), so the next engineer sees a choice rather than a habit.
- **Patterns that help:** none; the fix is the selection step. Start from [How to choose a pattern](how-to-choose-a-pattern.md).

## Speculative generality and premature abstraction

- **Symptom:** interfaces with one implementation and no test that needs a fake; generic type parameters only ever given one type; configuration options nobody sets; a `PaymentProviderFactory` "in case we add a second provider".
- **Why it hurts:** every indirection costs reading time on every visit. An abstraction shaped by a guess is usually wrong when the second real case arrives, and by then callers have bent themselves around it. Sandi Metz's summary: duplication is far cheaper than the wrong abstraction.
- **Refactoring:** inline the class, collapse the hierarchy, remove unused parameters. Duplicate until the rule of three shows what actually varies, then extract.
- **Patterns that help:** the move is to remove one. Reintroduce [Strategy](../src/behavioral/strategy/README.md) or an [Adapter](../src/structural/adapter/README.md) when the second real variant exists.

## Primitive obsession (money as a float)

- **Symptom:** `price: number` with no unit (rupees or paise?), a currency passed separately or not at all, `0.1 + 0.2` inside a total, IDs and email addresses as bare strings that the compiler lets you swap.
- **Why it hurts:** binary floating point cannot represent most decimal fractions, so totals drift by a paisa and reconciliation with the bank fails. Units get mixed. Validation is repeated at every use, and `refund(orderId, customerId)` compiles with its arguments reversed.
- **Refactoring:** replace the primitive with a value object. Money is an integer number of minor units plus a currency, with arithmetic that refuses to mix currencies and splits without losing a unit. Use `bigint` or a decimal library when amounts can exceed `Number.MAX_SAFE_INTEGER` minor units or need sub-unit precision (FX rates, per-second tariffs). Splitting a bill is where this usually bites; see the [Splitwise design](https://github.com/hardyalsinghdeora/low-level-design/blob/main/problems/splitwise.md).
- **Patterns that help:** value objects, [Flyweight](../src/structural/flyweight/README.md) for shared currency metadata, branded types for IDs.

```ts
const drift = 0.1 + 0.2; // 0.30000000000000004, not 0.3

type Currency = 'INR' | 'USD';
class Money {
  private constructor(readonly minor: number, readonly currency: Currency) {
    if (!Number.isSafeInteger(minor)) throw new Error('money is a whole number of minor units');
  }
  static of(minor: number, currency: Currency): Money { return new Money(minor, currency); }
  add(other: Money): Money {
    if (other.currency !== this.currency) throw new Error('currency mismatch');
    return new Money(this.minor + other.minor, this.currency);
  }
  /** Splits a non-negative amount without losing a unit: 1000 in 3 parts is 334 + 333 + 333. */
  allocate(parts: number): Money[] {
    const base = Math.floor(this.minor / parts);
    const remainder = this.minor % parts;
    return Array.from({ length: parts }, (_, i) => new Money(base + (i < remainder ? 1 : 0), this.currency));
  }
}

type OrderId = string & { readonly brand: 'OrderId' }; // not assignable from a plain string or another ID
```

## Shotgun surgery

- **Symptom:** one business change, such as a new payment method or order status, touches a dozen files: the enum, three switches, a mapper, a validator, a DTO, a fee table.
- **Why it hurts:** missing one place is a production bug the compiler did not catch; pull requests are large; the knowledge of what a payment method *is* exists nowhere as a unit.
- **Refactoring:** move the scattered behaviour into one place per variant (Move Method, Move Field) and replace the switches with polymorphism. Where a switch stays, make it exhaustive so the compiler lists every site.
- **Patterns that help:** [Strategy](../src/behavioral/strategy/README.md) or [State](../src/behavioral/state/README.md), so one class owns everything about one variant; [Specification](../src/modern/specification/README.md) for a rule repeated in several places. The mirror image, one class that changes for many unrelated reasons, is divergent change, and it grows into a God object.

## Feature envy

- **Symptom:** a method that mostly reads another object's fields: `TaxService` checks `invoice.customer.address.country`, `invoice.customer.taxId` and `invoice.customer.exempt` before deciding anything.
- **Why it hurts:** behaviour sits away from its data, so it is duplicated wherever the decision is needed, and every change to the data's shape ripples through the envious callers.
- **Refactoring:** move the method to the object that owns the data, and ask that object a question instead: `customer.isTaxableIn('IN')`. Long getter chains are the same smell seen from outside (the Law of Demeter).
- **Patterns that help:** mainly principles: tell, don't ask, and least knowledge (see [Design principles](design-principles.md)). [Visitor](../src/behavioral/visitor/README.md) and [Strategy](../src/behavioral/strategy/README.md) separate behaviour from data on purpose; that is the exception, chosen when operations vary more than the data does.

## Leaky abstraction

- **Symptom:** callers of `UserRepository.save` catch the ORM's error and check Postgres error code `23505`; a `FileStore` interface only works with keys that follow S3's rules; `findAll()` returns every row; repositories return ORM entities whose lazy relations fire queries from the HTTP layer.
- **Why it hurts:** callers couple to the implementation anyway, so the abstraction costs indirection and protects nothing. Swapping the implementation breaks callers, and performance problems (N+1 queries, unbounded reads) surface far from their cause.
- **Refactoring:** translate errors at the boundary into domain errors (`EmailAlreadyRegistered`), return plain domain objects, page every collection, and put the costs that cannot be hidden into the interface: a remote call can time out, so accept a timeout or return a result type instead of pretending it is local.
- **Patterns that help:** [Adapter](../src/structural/adapter/README.md) as an anti-corruption layer, a [Repository](../src/modern/repository/README.md) that returns domain types, [Iterator](../src/behavioral/iterator/README.md) for paging. Joel Spolsky's law of leaky abstractions says every non-trivial abstraction leaks to some degree; the goal is leaks that are documented and deliberate.

## Distributed monolith

- **Symptom:** services that must be deployed together, a database that several services write to, synchronous call chains five services deep, and a shared library of domain models that every service upgrades in lockstep.
- **Why it hurts:** you pay for distribution (network failures, latency, eventual consistency, more infrastructure) and keep the coupling of a monolith. Availability multiplies down a synchronous chain: five services at 99.9% each give about 99.5%.
- **Refactoring:** redraw boundaries around business capabilities and data ownership, so each service owns its tables and others reach that data through its API or its events. Replace synchronous chains with events where the caller does not need an immediate answer. When the boundaries were wrong, merging back into a modular monolith is a legitimate fix.
- **Patterns that help:** [Transactional Outbox](../src/modern/transactional-outbox/README.md) for reliable events, [Saga](../src/modern/saga/README.md) for cross-service workflows, [CQRS](../src/modern/cqrs/README.md) read models instead of synchronous fan-out, [Circuit Breaker](../src/modern/circuit-breaker/README.md) and [Bulkhead](../src/modern/bulkhead/README.md) on the calls that remain.

## Chatty services

- **Symptom:** one request calls another service in a loop: fifty `GET /customers/{id}` calls to render one order list, or fine-grained endpoints such as `getCustomerName` and `getCustomerEmail`.
- **Why it hurts:** latency adds up (fifty sequential calls at 20 ms is a second), each call is another failure point, and the callee's load and rate limits scale with your loops. It is the N+1 query problem over HTTP.
- **Refactoring:** batch endpoints (`GET /customers?ids=...`), coarse-grained APIs shaped by use cases, request-scoped batching and caching (the DataLoader approach), or a local copy of the data you need, kept fresh from the owner's events.
- **Patterns that help:** [Facade](../src/structural/facade/README.md) for a coarse-grained API, [Proxy](../src/structural/proxy/README.md) for caching and batching, [CQRS](../src/modern/cqrs/README.md) read models fed by events.

## Retry storms

- **Symptom:** a dependency slows down, traffic to it triples, and it does not recover until clients are stopped. Each layer retries on its own: if the client, the gateway and the service each make up to 4 attempts, one user action becomes up to 4 x 4 x 4 = 64 calls to the struggling dependency. Retries without jitter arrive in synchronized waves.
- **Why it hurts:** retries add load exactly when the dependency has the least capacity. The feedback loop can keep a system down after the original trigger is gone.
- **Refactoring:** retry at one layer only; use exponential backoff with full jitter and cap both attempts and total time; keep a retry budget (for example, retries may not exceed 10% of requests); retry only retryable errors (timeouts, 503, and 429 after its `Retry-After`), never validation errors; make operations idempotent so a retry is safe; propagate deadlines so nobody retries work whose caller has already given up.
- **Patterns that help:** [Retry with backoff](../src/modern/retry-with-backoff/README.md) done properly, [Circuit Breaker](../src/modern/circuit-breaker/README.md) to stop calling, [Bulkhead](../src/modern/bulkhead/README.md) to contain the damage. More in [resilience patterns](https://github.com/hardyalsinghdeora/system-design/blob/main/fundamentals/resilience-patterns.md).
