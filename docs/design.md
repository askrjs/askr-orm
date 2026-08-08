# Design boundary

The ORM intentionally resembles SQL more than an object graph.

- Schema definitions are executable TypeScript metadata, not live
  connections.
- Generated entities are readonly plain objects.
- Inserts, patches, and keys are separate inferred contracts.
- CRUD returns row counts unless row returning is requested.
- Read builders are immutable and parameterized.
- Joins have explicit targets, aliases, `on` predicates, and projections.
- Transactions are caller-owned.
- Views are read-only.
- Multiple database roots are independent.

This design excludes relationship navigation, shared migration history across
databases, cross-database joins, implicit transactions, nested
writes, and client-side query evaluation.
