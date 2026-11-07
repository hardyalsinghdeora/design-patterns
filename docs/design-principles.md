# Design principles

Patterns are worked examples of a small set of principles. If you remember the principle, you can rebuild the pattern, and you can tell when a pattern is not needed. Each entry: the principle in two lines, the patterns that embody it, and a short example where it helps. SOLID is covered in depth in [SOLID principles](https://github.com/hardyalsinghdeora/low-level-design/blob/main/docs/solid-principles.md); OOP basics are in [OOP fundamentals](https://github.com/hardyalsinghdeora/low-level-design/blob/main/docs/oop-fundamentals.md).

| Principle | Embodied by |
|---|---|
| Encapsulate what varies | Strategy, State, Bridge, Template Method |
| Program to an interface | Adapter, Repository, Factory Method, Dependency Injection |
| Composition over inheritance | Strategy, Decorator, Composite, Bridge |
| Open/closed | Strategy, Decorator, Visitor, Chain of Responsibility, Middleware Pipeline |
| Dependency inversion | Repository, Adapter, Dependency Injection |
| Single responsibility | Facade, Command, Unit of Work, CQRS |
| Least knowledge | Facade, Mediator |
| Hollywood principle | Template Method, Observer, Middleware Pipeline, frameworks in general |
| Tell, don't ask | State, Command, Specification |
| DRY, KISS, YAGNI | The reason to skip a pattern |

## Encapsulate what varies

Find the part of the code that changes for reasons the rest does not, and put it behind its own boundary. The stable part then stops being edited every time the varying part changes.

Patterns: [Strategy](../src/behavioral/strategy/README.md) (the algorithm varies), [State](../src/behavioral/state/README.md) (behaviour per status), [Bridge](../src/structural/bridge/README.md) (two dimensions vary), [Template Method](../src/behavioral/template-method/README.md) (steps vary, order does not).

```ts
// Shipping rates change per carrier; checkout does not.
type RateCalculator = (weightGrams: number, zone: string) => number; // minor units
class Checkout {
  constructor(private readonly rate: RateCalculator) {}
  shippingFor(order: Order): number { return this.rate(order.weightGrams, order.zone); }
}
```

## Program to an interface, not an implementation

Depend on what an object does, not on the class that does it. Callers keep working when the implementation is swapped, wrapped or faked.

Patterns: [Adapter](../src/structural/adapter/README.md), [Repository](../src/modern/repository/README.md), [Factory Method](../src/creational/factory-method/README.md), [Dependency Injection](../src/modern/dependency-injection/README.md), [Proxy](../src/structural/proxy/README.md).

```ts
interface FileStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}
// S3FileStore in production, InMemoryFileStore in tests; InvoiceArchiver never knows which.
class InvoiceArchiver {
  constructor(private readonly store: FileStore) {}
}
```

## Composition over inheritance

Build behaviour by holding objects rather than extending classes. Composition can change at runtime, combines freely and does not tie you to a parent's internals.

Patterns: [Strategy](../src/behavioral/strategy/README.md), [Decorator](../src/structural/decorator/README.md), [Composite](../src/structural/composite/README.md), [Bridge](../src/structural/bridge/README.md).

```ts
// Instead of CachedRetryingHttpClient extends RetryingHttpClient extends HttpClient:
const client: HttpClient = new CachingClient(new RetryingClient(new FetchClient(), { attempts: 3 }), cache);
```

Inheritance is still right for a true "is-a" with a stable base, and for Template Method where the base class owns the algorithm.

## Open/closed

Modules should be open for extension and closed for modification: a new variant is new code, not an edit to tested code. Apply it where variation has actually happened, not everywhere.

Patterns: [Strategy](../src/behavioral/strategy/README.md), [Decorator](../src/structural/decorator/README.md), [Visitor](../src/behavioral/visitor/README.md) (new operations), [Chain of Responsibility](../src/behavioral/chain-of-responsibility/README.md), [Middleware Pipeline](../src/modern/middleware-pipeline/README.md).

```ts
// Adding a fraud rule is a new handler registered at startup; the pipeline is untouched.
const checks: FraudCheck[] = [velocityCheck, blockedCountryCheck, amountThresholdCheck];
```

## Dependency inversion

High-level policy should not depend on low-level detail; both depend on an abstraction, and the policy owns that abstraction. The domain defines `PaymentGateway`; the Stripe adapter implements it.

Patterns: [Repository](../src/modern/repository/README.md), [Adapter](../src/structural/adapter/README.md), [Dependency Injection](../src/modern/dependency-injection/README.md) (the mechanism that wires it).

```ts
// domain/payment-gateway.ts  (owned by the domain)
export interface PaymentGateway { charge(amountMinor: number, currency: string, idempotencyKey: string): Promise<ChargeResult>; }
// infrastructure/stripe-gateway.ts imports the domain interface, never the other way round.
```

## Single responsibility

A module should have one reason to change, meaning one actor or concern that asks for changes. Split when two groups of people would edit the same class for different reasons.

Patterns: [Facade](../src/structural/facade/README.md) (orchestration apart from the parts), [Command](../src/behavioral/command/README.md) (one request per object), [Unit of Work](../src/modern/unit-of-work/README.md) (transaction handling apart from business rules), [CQRS](../src/modern/cqrs/README.md) (reads apart from writes).

## Least knowledge (Law of Demeter)

A method should talk to its own fields, its parameters and objects it creates, not reach through them. `order.customer.address.country.taxRate` couples you to four classes' structure.

Patterns: [Facade](../src/structural/facade/README.md), [Mediator](../src/behavioral/mediator/README.md).

```ts
// Reaching through: breaks when Customer stores addresses differently.
const rate = order.customer.address.country.taxRate;
// Asking the nearest object: Order decides how to find its tax jurisdiction.
const rate = order.taxRate();
```

It is about structure, not dots: a fluent builder chain (`query.where(...).limit(10)`) returns the same kind of object each time and does not violate it.

## Hollywood principle ("don't call us, we'll call you")

Low-level components plug into a framework or a base class, and the higher level decides when to call them. It is the idea behind inversion of control.

Patterns: [Template Method](../src/behavioral/template-method/README.md) (the base class calls your hooks), [Observer](../src/behavioral/observer/README.md) (the subject calls listeners), [Middleware Pipeline](../src/modern/middleware-pipeline/README.md) (the framework calls your handler). Every web framework works this way: you write the handler, the framework calls it.

## Tell, don't ask

Tell an object what to do instead of pulling its data out and deciding for it. The rule then lives next to the data it needs, and invalid states are harder to create.

Patterns: [State](../src/behavioral/state/README.md), [Command](../src/behavioral/command/README.md), [Specification](../src/modern/specification/README.md).

```ts
// Asking: every caller re-implements the rule.
if (invoice.status === 'open' && invoice.dueDate < now) invoice.status = 'overdue';
// Telling: Invoice owns the transition and can refuse it.
invoice.markOverdueIfDue(now);
```

## DRY, KISS, YAGNI

DRY: each piece of knowledge has one authoritative place. Duplicated code is fine when it only looks alike; duplicated rules are not. KISS: prefer the simplest design that works and that the next reader can follow. YAGNI: do not build for a requirement that has not arrived.

These are the brakes on everything above. A Strategy interface with one implementation, a factory that builds one class or a mediator between two objects violates YAGNI. A good default is the rule of three: tolerate duplication twice, extract on the third case. See [Speculative generality](./anti-patterns.md#speculative-generality-and-premature-abstraction) and [How to choose a pattern](./how-to-choose-a-pattern.md).

## Putting them together

When you review a design, ask in this order:

1. What varies, and is it isolated? (encapsulate what varies)
2. Do callers depend on interfaces the caller's layer owns? (program to an interface, dependency inversion)
3. Can a new variant be added without editing tested code? (open/closed)
4. Does each class have one reason to change? (single responsibility)
5. Is anything here for a requirement we do not have? (YAGNI)

The answers usually point to one pattern, or to removing one.
