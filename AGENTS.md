# AGENTS.md

Operational guide for `@askrjs/orm`, which owns explicit SQL-shaped access for
PostgreSQL and SQLite.

## Askr North Star

Keep the path from declared database and query through adapter execution to
typed result narratable. Enforce schema, placeholder, transaction, connection,
and generated-contract invariants with specific corrective errors. Test each
primitive's failure, rollback, concurrency, and cleanup paths against real
adapters where relevant. Preserve the seam between SQL declarations, generated
metadata, and dialect adapters. Prefer explicit queries and transactions over
inferred relations or hidden persistence behavior. Do not add ORM convenience
surface without a demonstrated application need.

Run `npm run check` before declaring a change ready; it includes coverage,
types, packaging, and benchmarks. Run real PostgreSQL and SQLite integration
lanes for adapter-sensitive changes.

## Optimization Gate

A benchmark number is only half of an optimization's success criterion. The
change must also preserve a causal path that a human or agent can narrate in one
sentence.

Every benchmark-driven change must include:

1. the one-sentence causal description of the optimized path;
2. the exact fallback trigger and proof that optimized and fallback paths have
   identical observable behavior and error surfaces;
3. an explicit legibility-cost statement, including `none` when no new path or
   concept is introduced; and
4. evidence that a measured bottleneck in a real application justifies the
   optimization now.

Prefer making the existing single path faster. New caches, inference,
memoization, shortcuts, fast paths, or scheduler states require an explicit
legibility decision; a speedup alone does not justify them.
