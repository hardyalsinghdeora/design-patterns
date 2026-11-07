# Design Patterns in TypeScript

[![CI](https://github.com/hardyalsinghdeora/design-patterns/actions/workflows/ci.yml/badge.svg)](https://github.com/hardyalsinghdeora/design-patterns/actions/workflows/ci.yml)

The 23 Gang of Four design patterns and the modern backend patterns that come up in interviews and production code. Every pattern uses a backend example (payments, orders, invoices, notifications, queues) instead of shapes and animals, and ships with a class diagram, a runnable demo, tests that prove what the pattern promises, and the interview questions that come with it.

## Quick start

```bash
npm install
npm test                    # runs every pattern's tests
npm run typecheck           # strict TypeScript, no any
npm run demo                # lists the runnable demos
npm run demo -- strategy    # runs one walkthrough
```

Requires Node.js 20 or newer.

## Guides

| Guide | What it covers |
|---|---|
| [How to choose a pattern](docs/how-to-choose-a-pattern.md) | A symptom-to-pattern decision table, and when not to use a pattern at all |
| [Pattern confusions](docs/pattern-confusions.md) | Strategy vs State, Adapter vs Facade vs Proxy vs Decorator, CQRS vs event sourcing, and more |
| [Anti-patterns](docs/anti-patterns.md) | God objects, singleton abuse, distributed monoliths, retry storms, and how to refactor out of them |
| [Patterns in the wild](docs/patterns-in-the-wild.md) | Where these patterns appear in Node.js and widely used libraries |
| [Interview cheat sheet](docs/interview-cheatsheet.md) | One line per pattern and the most common interview questions with answers |
| [Design principles](docs/design-principles.md) | The principles patterns serve: encapsulate what varies, composition over inheritance, and more |

## Creational patterns

How objects get created, so that callers do not depend on concrete classes or complicated construction.

<!-- BEGIN:creational -->
| Pattern | Intent |
|---|---|
| [Singleton](src/creational/singleton/) | Ensure a class has exactly one instance in the process and give the rest of the code one well-known way to reach it. |
| [Factory Method](src/creational/factory-method/) | Let a base class own an algorithm that needs an object, and let subclasses decide which concrete object that is by overriding one creation method. |
| [Abstract Factory](src/creational/abstract-factory/) | Provide one interface for creating a *family* of related objects, so the client gets products that are guaranteed to belong together without naming any concrete class. |
| [Builder](src/creational/builder/) | Separate *how* a complex object is put together from the object itself: callers add parts step by step through a small API, and one `build()` call validates the whole thing and returns a finished, immutable result. |
| [Prototype](src/creational/prototype/) | Create new objects by copying an existing, fully configured instance (the prototype) and adjusting the copy, instead of building each one from scratch or knowing which class and settings produced it. |
<!-- END:creational -->

## Structural patterns

How objects are composed into larger structures while keeping them flexible.

<!-- BEGIN:structural -->
| Pattern | Intent |
|---|---|
| [Adapter](src/structural/adapter/) | Make an existing class usable through an interface it was not written for. |
| [Bridge](src/structural/bridge/) | Separate an abstraction from its implementation so the two can vary independently. |
| [Composite](src/structural/composite/) | Arrange objects in a tree and give single objects and groups of objects the same interface, so client code can work with either without asking which one it has. |
| [Decorator](src/structural/decorator/) | Add behaviour to an individual object at runtime by wrapping it in another object that has the same interface. |
| [Facade](src/structural/facade/) | Give a set of subsystems one simple, task-shaped entry point. |
| [Flyweight](src/structural/flyweight/) | Support a very large number of fine-grained objects cheaply by sharing the part of their state that is identical (intrinsic state) and keeping the part that varies (extrinsic state) outside the shared object. |
| [Proxy](src/structural/proxy/) | Put a stand-in in front of an object that has *the same interface*, so it can control access to the real object: create it lazily, cache its answers, check permissions, or limit how often it is called. |
<!-- END:structural -->

## Behavioral patterns

How objects divide responsibilities and communicate.

<!-- BEGIN:behavioral -->
| Pattern | Intent |
|---|---|
| [Chain of Responsibility](src/behavioral/chain-of-responsibility/) | Give more than one object a chance to handle a request by passing it along a chain until one of them deals with it. |
| [Command](src/behavioral/command/) | Turn a request into an object. |
| [Iterator](src/behavioral/iterator/) | Give sequential access to the elements of a collection without exposing how it is stored, fetched or traversed. |
| [Mediator](src/behavioral/mediator/) | Move the rules about how a group of objects interacts into one object, the *mediator*. |
| [Memento](src/behavioral/memento/) | Capture an object's internal state as an opaque token so the object can be put back into that state later, without breaking its encapsulation. |
| [Observer](src/behavioral/observer/) | Let one object (the *subject*) announce that something happened, and let any number of other objects (the *observers*) react, without the subject knowing who they are. |
| [State](src/behavioral/state/) | Let an object change its behaviour when its internal state changes, by delegating each operation to a state object and swapping that object on a transition. |
| [Strategy](src/behavioral/strategy/) | Define a family of interchangeable algorithms, encapsulate each one, and let the client choose one at runtime. |
| [Template Method](src/behavioral/template-method/) | Define the skeleton of an algorithm once, in a base class method, and let subclasses supply some of the steps. |
| [Visitor](src/behavioral/visitor/) | Separate operations from the object structure they run over. |
| [Interpreter](src/behavioral/interpreter/) | Give a small language a grammar, represent each grammar rule as a class, and evaluate a sentence by parsing it into a tree of those classes and asking the root to `evaluate(context)`. |
<!-- END:behavioral -->

## Modern backend patterns

Not in the GoF book, but asked constantly in backend and system design interviews: persistence, composition roots, request pipelines, resilience and distributed data.

<!-- BEGIN:modern -->
| Pattern | Intent |
|---|---|
| [Repository](src/modern/repository/) | Give the domain a collection-like interface for one kind of aggregate (find, query by specification, save, delete) and hide how it is stored. |
| [Unit of Work](src/modern/unit-of-work/) | Keep track of every object a business transaction reads, creates, changes or deletes, and write all of those changes to the database together at the end, in one transaction and in a safe order. |
| [Specification](src/modern/specification/) | Put each business rule in a small object that answers `isSatisfiedBy(candidate)`, and build policies by combining those objects with `and`, `or` and `not`. |
| [Null Object](src/modern/null-object/) | Represent "nothing here" with an object that implements the expected interface and does the neutral thing: a logger that discards, metrics that count nothing, a cache that always misses, a customer with no rights. |
| [Dependency Injection](src/modern/dependency-injection/) | A class declares what it needs (usually as constructor parameters typed by interfaces) and someone else supplies it. |
| [Object Pool](src/modern/object-pool/) | Keep a bounded set of expensive, reusable objects and lend them out instead of creating one for each use. |
| [Middleware Pipeline](src/modern/middleware-pipeline/) | Build a request handler out of small, independent functions `(ctx, next)` composed into a single pipeline. |
| [Circuit Breaker](src/modern/circuit-breaker/) | Put a stateful guard in front of a remote dependency. |
| [Retry with Backoff](src/modern/retry-with-backoff/) | Re-run an operation that failed for a transient reason, waiting longer between attempts and adding randomness to the wait, within limits on attempts, delay and total time, so that a brief blip is absorbed without turning a struggling dependency into a dead one. |
| [Bulkhead](src/modern/bulkhead/) | Partition capacity into compartments, one per dependency (or per tenant, or per workload), each with its own concurrency limit and bounded queue, so that one slow or failing dependency can fill only its own compartment. |
| [Transactional Outbox](src/modern/transactional-outbox/) | Make "change the database" and "announce the change" atomic without a distributed transaction: write the event into an *outbox* table in the same local transaction as the business data, and let a separate relay publish outbox rows to the message broker afterwards. |
| [Saga](src/modern/saga/) | Keep data consistent across services without a distributed transaction: split the business transaction into local steps, give each step a compensating action, and when a step fails, run the compensations of the steps that already committed, in reverse order. |
| [CQRS (Command Query Responsibility Segregation)](src/modern/cqrs/) | Use one model to change state and a different model to read it. |
| [Event Sourcing](src/modern/event-sourcing/) | Persist the sequence of things that happened to an aggregate, not its current state. |
<!-- END:modern -->

## How each pattern is documented

Every folder under `src/<category>/<pattern>/` has the same four files:

| File | Contents |
|---|---|
| `README.md` | Intent, the problem it solves, a class diagram, participants, when to use it, when not to, real-world sightings, related patterns, pitfalls, interview Q&A |
| `<pattern>.ts` | The implementation, with the TypeScript-idiomatic form shown next to the classic one where they differ |
| `demo.ts` | A console walkthrough: `npm run demo -- <pattern>` |
| `<pattern>.test.ts` | Tests that prove the pattern's promise: swap at runtime, extend without editing, isolate for testing |

Conventions are in [STYLE.md](STYLE.md).

## Companion repositories

- [low-level-design](https://github.com/hardyalsinghdeora/low-level-design): object-oriented design interview problems that put these patterns to work.
- [system-design](https://github.com/hardyalsinghdeora/system-design): high-level design fundamentals, classic interview problems and runnable building blocks.

## License

[MIT](LICENSE)
