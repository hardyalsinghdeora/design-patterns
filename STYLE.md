# Conventions for this repository

One folder per pattern, every folder has the same four files. `src/behavioral/strategy/` is the reference.

```
src/<category>/<pattern>/
  README.md          the write-up (sections below)
  <pattern>.ts       the implementation: a realistic backend example, not Duck/Animal
  demo.ts            console walkthrough: `npm run demo -- <pattern>`
  <pattern>.test.ts  vitest tests that prove the pattern's promise (swap, extend, isolate)
```

Categories: `creational`, `structural`, `behavioral`, `modern` (patterns that are not in the GoF book but are asked in backend interviews).

## README sections, in this order

1. Title, then a line with category, code link, run commands.
2. **Intent** (one or two sentences, in your own words).
3. **The problem it solves** (a concrete scenario with the smell: a growing switch, tangled construction, etc.).
4. **The solution**: a Mermaid `classDiagram` of this example, and a participants table mapping the GoF roles to the classes in the code.
5. **When to use it** (bullets).
6. **When not to use it** (bullets; this is what separates a senior answer).
7. **Real-world sightings** (Node/TypeScript ecosystem and backend systems).
8. **Related patterns** (how it differs from the ones it is confused with).
9. **Pitfalls**.
10. **Interview Q&A**: 3-5 questions with crisp answers.

## Code rules

- Strict TypeScript, no `any`. `npm run typecheck` and `npm test` must pass.
- Examples come from backend work: payments, orders, invoices, notifications, caching, HTTP, queues, files. No shapes, ducks or pizzas.
- Money is an integer in minor units. Never floats.
- Show the TypeScript-idiomatic form when it differs from the Java-style class diagram (functions as strategies, closures for Command, `EventEmitter` for Observer, mixins/decorators), but keep the classic form too so the diagram matches the code.
- Comments explain *why*; a header comment on each file states the pattern in two lines.
- Tests prove the pattern's promise: add a variant without touching the context, swap at runtime, isolate for testing, etc. 5-10 tests per pattern.
- `console.log` only in `demo.ts`.
