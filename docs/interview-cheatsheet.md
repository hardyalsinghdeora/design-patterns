# Interview cheatsheet

One table per category: the intent in one line, the sentence to say when the pattern comes up, a typical backend use and the write-up. Then the questions that come up most often, with answers short enough to say out loud.

## Creational

| Pattern | Intent | Say this | Backend use |
|---|---|---|---|
| [Singleton](../src/creational/singleton/README.md) | One instance with a global access point | "One instance per process is fine; I hand it out through DI, not `getInstance()`, so tests can replace it." | Config, connection pool, metrics registry |
| [Factory Method](../src/creational/factory-method/README.md) | A method decides which concrete class to create | "Callers depend on the interface; the choice of class lives in one place." | `createNotifier(channel)`, parser per content type |
| [Abstract Factory](../src/creational/abstract-factory/README.md) | Create families of related objects that must match | "One factory per family guarantees I never mix an AWS queue with a GCP secret store." | Cloud provider kits, test vs production infrastructure |
| [Builder](../src/creational/builder/README.md) | Build a complex object step by step, validate at the end | "Many optional parts and an invariant to check: build it fluently, validate in `build()`." | Query builders, HTTP requests, email messages |
| [Prototype](../src/creational/prototype/README.md) | Create objects by cloning a configured instance | "Copy a preconfigured template; the hard part is deep vs shallow copy." | Invoice templates, default request configs |

## Structural

| Pattern | Intent | Say this | Backend use |
|---|---|---|---|
| [Adapter](../src/structural/adapter/README.md) | Convert one interface into the one the client expects | "The vendor SDK sits behind our port, so the domain never imports it." | Payment gateway SDKs, S3 vs local file store |
| [Bridge](../src/structural/bridge/README.md) | Let abstraction and implementation vary independently | "Two dimensions of change composed, not multiplied into subclasses." | Notification type x delivery channel |
| [Composite](../src/structural/composite/README.md) | Treat single objects and groups the same, as a tree | "Leaf and group share an interface, so the client recurses without type checks." | Product bundles, permission groups, nested rules |
| [Decorator](../src/structural/decorator/README.md) | Add behaviour by wrapping with the same interface | "Caching, retries and metrics stack as wrappers; the core class does not change." | Cached repository, retrying HTTP client |
| [Facade](../src/structural/facade/README.md) | One simple entry point to a subsystem | "Callers get one method; the orchestration of five services hides behind it." | Checkout over inventory, payment, shipping |
| [Flyweight](../src/structural/flyweight/README.md) | Share immutable state among many small objects | "Split shared intrinsic state from per-object state to cut memory." | Currency and tax metadata, interned values |
| [Proxy](../src/structural/proxy/README.md) | A stand-in that controls access to the real object | "Same interface, but it decides when and whether the real call happens." | Lazy loading, access checks, remote stubs |

## Behavioral

| Pattern | Intent | Say this | Backend use |
|---|---|---|---|
| [Chain of Responsibility](../src/behavioral/chain-of-responsibility/README.md) | Pass a request along handlers until one handles it | "The sender does not know which handler acts; I can reorder or add handlers." | Approval limits, validation, fraud checks |
| [Command](../src/behavioral/command/README.md) | Turn a request into an object | "Requests become data, so I can queue, log, retry and undo them." | Job queues, undo, audit trail |
| [Iterator](../src/behavioral/iterator/README.md) | Traverse without exposing the structure | "In TypeScript it is the iterator protocol; async generators give lazy pagination." | Paginated APIs, DB cursors |
| [Mediator](../src/behavioral/mediator/README.md) | Centralise how peers interact | "Peers talk to the mediator, so many-to-many links become many-to-one." | Workflow coordinator, in-process command bus |
| [Memento](../src/behavioral/memento/README.md) | Snapshot and restore state without exposing internals | "The originator makes an opaque snapshot; the caretaker only stores it." | Draft versions, undo, checkpoints |
| [Observer](../src/behavioral/observer/README.md) | Notify dependents when a subject changes | "The publisher does not know its subscribers; in Node that is `EventEmitter`, and it is synchronous." | Domain events, cache invalidation |
| [State](../src/behavioral/state/README.md) | Change behaviour when internal state changes | "Each state is a class that owns its allowed transitions; the status switch disappears." | Order and payment lifecycles |
| [Strategy](../src/behavioral/strategy/README.md) | Interchangeable algorithms chosen at runtime | "The context depends on an interface; adding a variant is a new class, not a new branch." | Payment methods, pricing, retry policy |
| [Template Method](../src/behavioral/template-method/README.md) | Fix the skeleton, let subclasses fill steps | "The base class owns the order of steps; subclasses override hooks." | Import jobs, report exports |
| [Visitor](../src/behavioral/visitor/README.md) | Add operations to a stable structure without editing it | "Double dispatch: worth it when the types are stable and the operations keep growing." | Exporters over invoice lines, AST passes |
| [Interpreter](../src/behavioral/interpreter/README.md) | Represent a small grammar as classes and evaluate it | "Each rule is a node with `evaluate(context)`; fine for a small DSL, not for a real language." | Discount rules, feature-flag expressions |

## Modern and backend

| Pattern | Intent | Say this | Backend use |
|---|---|---|---|
| [Repository](../src/modern/repository/README.md) | Collection-like access to aggregates, persistence hidden | "The domain asks for orders by intent; SQL lives behind the interface, and tests use an in-memory fake." | `OrderRepository.findOverdue()` |
| [Unit of Work](../src/modern/unit-of-work/README.md) | Track changes and commit them as one transaction | "Every write in the use case commits together or not at all." | Order + stock + outbox row |
| [Specification](../src/modern/specification/README.md) | A business rule as a composable predicate | "Rules combine with and/or/not and serve both validation and queries." | Eligibility, filtering |
| [Null Object](../src/modern/null-object/README.md) | An object that does nothing safely, instead of null | "When 'do nothing' is valid behaviour, the null checks go away." | No-op logger, no discount |
| [Dependency Injection](../src/modern/dependency-injection/README.md) | Supply dependencies from outside | "The class declares what it needs; the composition root wires it; tests pass fakes." | Constructor injection, NestJS providers |
| [Object Pool](../src/modern/object-pool/README.md) | Reuse expensive objects, bounded | "Acquire, release, a size limit and a timeout; the sizing is the real decision." | DB connections, sockets, workers |
| [Middleware Pipeline](../src/modern/middleware-pipeline/README.md) | Compose handlers that run before and after `next()` | "An ordered chain where the order is part of the contract." | Auth, logging, rate limiting |
| [Circuit Breaker](../src/modern/circuit-breaker/README.md) | Stop calling a failing dependency, then probe | "Closed, open, half-open: fail fast instead of piling up timeouts." | Calls to a payment provider |
| [Retry with Backoff](../src/modern/retry-with-backoff/README.md) | Retry transient failures with growing, jittered delays | "Only retryable errors, only idempotent calls, with jitter and a cap." | 503s, timeouts, deadlocks |
| [Bulkhead](../src/modern/bulkhead/README.md) | Isolate resources so one failure cannot drain all | "Separate pools or concurrency limits per dependency." | Per-dependency or per-tenant limits |
| [Transactional Outbox](../src/modern/transactional-outbox/README.md) | Store the event with the state change, publish later | "No dual write: the event commits with the data and is published at least once." | `OrderPlaced` to a broker |
| [Saga](../src/modern/saga/README.md) | A multi-service transaction as local steps with compensations | "No distributed lock; each step has an undo; orchestrated or choreographed." | Order, payment, shipping |
| [CQRS](../src/modern/cqrs/README.md) | Separate the write model from read models | "Commands go through the domain; queries read projections shaped for the screen." | Dashboards, search views |
| [Event Sourcing](../src/modern/event-sourcing/README.md) | Store state as an append-only event log | "The log is the source of truth; I gain audit and replay and pay in versioning and projections." | Ledgers, audit-heavy domains |

## The 15 questions that come up most

**1. Is Singleton an anti-pattern?**
The single instance is not the problem; the global access point is. `getInstance()` hides a dependency, couples callers to a concrete class and leaks state between tests. Keep one instance per process if you need it (a pool, a config), create it in the composition root and inject it.

**2. Strategy vs State?**
Same structure, different driver. With Strategy the client picks the algorithm and the strategies do not know each other. With State the object changes its own behaviour as its state changes, and the states own the transitions (`Pending` can go to `Paid`, `Shipped` cannot go back).

**3. How do you implement undo?**
Two options. Command: each command has `execute()` and `undo()`, executed commands go on a history stack, undo pops and reverses, and a new command clears the redo stack. Memento: snapshot state before each change and restore it; simpler, more memory. In a persisted or distributed system, undo becomes a compensating action recorded as a new event, not a deletion.

**4. How do you make a payment call safe to retry?**
Make it idempotent first. The client generates an idempotency key per logical payment and sends it on every attempt; the server stores key, request hash and result under a unique constraint and returns the stored result on a repeat (and rejects the same key with a different body). Retry only retryable errors with backoff and jitter. On a timeout the outcome is unknown, so query the provider's status for that key before charging again, and reconcile daily.

**5. When would you use event sourcing, and when not?**
Use it when history is the product: ledgers, audit requirements, temporal queries ("balance on 1 March"), or many read models built from the same facts. Avoid it for CRUD screens, when the team has not run it before, or when you only need an audit log (an audit table is cheaper). Costs: event versioning, projection rebuilds, eventual consistency and harder ad-hoc queries.

**6. Decorator vs Proxy?**
Both wrap an object with the same interface. A Decorator adds behaviour and is meant to be stacked by the client. A Proxy controls access (lazy creation, permissions, remoting), usually manages the real object's lifecycle, and the client often does not know it is there.

**7. Adapter vs Facade?**
An Adapter makes one existing interface fit another that a client already expects. A Facade defines a new, simpler interface over a whole subsystem. Adapter is about compatibility; Facade is about simplicity.

**8. Factory Method vs Abstract Factory?**
Factory Method creates one product and lets a subclass or a function decide the concrete type. Abstract Factory creates a family of related products that must be used together, through one object per family.

**9. When do you reach for Builder instead of a constructor?**
When there are many optional parts, when the object must satisfy an invariant before it is used, or when construction reads better as steps. In TypeScript, an options object with defaults covers many cases; use a Builder when validation or step order matters.

**10. Observer vs publish/subscribe?**
Observer is in-process: subscribers register with the subject directly and are usually called synchronously. Pub/sub puts a broker between them, so publishers and subscribers do not know each other, can run in different processes and are decoupled in time. Pub/sub adds delivery guarantees, ordering and retries as concerns.

**11. How do you publish an event reliably after a database write?**
Transactional outbox: in the same transaction as the state change, insert the event into an outbox table. A relay reads unpublished rows and publishes them, marking them sent. Delivery is at least once, so consumers must be idempotent (dedupe on event ID).

**12. Saga: orchestration or choreography?**
Orchestration has one coordinator that calls each step and its compensation; the flow is visible in one place and easier to change. Choreography lets each service react to the previous event; fewer moving parts for two or three steps, but the flow is spread across services. Beyond three or four steps, prefer orchestration.

**13. Doesn't the ORM already give you a Repository?**
It gives generic data access (`find`, `save`). A domain repository speaks the domain's language (`findOverdueForCustomer`), returns aggregates, hides the ORM from the domain and can be replaced by an in-memory fake in tests. If the domain is thin CRUD, using the ORM directly is fine.

**14. How do retry and circuit breaker work together?**
Put the timeout on each attempt, the breaker around each attempt, and the retry loop outside. Every failed attempt counts towards opening the breaker, and an open breaker fails immediately with an error the retry policy treats as not retryable. Without the breaker, retries keep hammering a dependency that is down.

**15. Dependency injection vs service locator?**
With DI, a class receives its dependencies through the constructor, so they are visible in its signature and easy to fake. With a service locator, the class asks a global registry from inside its methods, which hides dependencies and fails at runtime instead of at wiring time. Use the container only in the composition root.

Further reading: [How to choose a pattern](./how-to-choose-a-pattern.md), [Pattern confusions](./pattern-confusions.md), [Anti-patterns](./anti-patterns.md), [Design principles](./design-principles.md), [Patterns in the wild](./patterns-in-the-wild.md).
