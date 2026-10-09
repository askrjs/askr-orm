# Changelog

## Unreleased

### Breaking

- Curate the root to 68 names and the tooling subpath to its single runDatabaseCli
  bridge. Remove 54 named exports and sql.key. Replace direct client construction
  with defineDatabase/open; use sql.identifier/literal/unsafe and defineQuery for
  their canonical contracts. Every removed name has migration guidance in
  docs/0.5.0-api.md. Retain all five export-map keys and optional PostgreSQL peers.

### Added

- Optional DatabaseAdapter.executeScript for complete migration scripts; custom
  drivers without it keep the existing execute fallback. PostgreSQL and SQLite
  implementations execute driver-owned scripts without splitting semicolons.
- Exact packed runtime/declaration checks, removed-import and private-path checks,
  optional-peer isolation/minimum installs, and real-adapter value parity probes.

### Fixed

- SQLite migration execution no longer drops all statements after the first.
- PostgreSQL migration scripts no longer fail when the driver returns multiple
  result sets.
- Failed SQLite rollback closes and quarantines the adapter, rolls back remaining
  writes and releases shared-file ownership before a new connection recovers.
- PostgreSQL failed rollback/advisory unlock discards poisoned pooled connections
  while preserving the primary operation error; failed statement deallocation
  still releases and discards the owned client.
- Update compatible development tooling to audited versions and add TypeScript 6 compiler-API audits alongside the TypeScript 7 gate and pin
  the matching coverage provider.

### Remaining release gate

- PostgreSQL shadow reset/introspection/query description are incomplete in the
  advertised generation/validation workflow (#55). No ORM 0.5.0 readiness or
  publication claim is made until that real workflow is qualified.
