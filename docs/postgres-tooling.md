# PostgreSQL generated-artifact tooling

`generate`, `validate` and manual-artifact refresh use the configured **disposable
scratch database**. Reset removes all non-system schemas and their dependent
objects from that database, then recreates `public`. Do not configure a database
containing data you intend to keep as `shadowUrl` / `DATABASE_SHADOW_URL`.

The application target is never reset or migrated by these commands. Before
scratch reset, tooling opens a read-only target transaction and holds a random
two-integer session advisory lock. The scratch connection must independently
acquire the same key while the target still owns its lock. The target must then
successfully unlock it. A shared actual database, an unavailable target, or a
lost lock owner fails closed before destructive SQL. URL spelling is not proof
of separation. The target connection needs connection and advisory-lock rights;
this guard reads no application tables and requires no superuser catalog access.

[PostgreSQL documents database-local advisory locks](https://www.postgresql.org/docs/16/view-pg-locks.html)
and the separate integer-key namespaces and session unlock semantics in its
[advisory lock functions](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS).

One scratch adapter owns one physical session, serializes its method calls and
holds a distinct workflow advisory lock until close. Two Askr tooling processes
therefore cannot interleave reset/replay/probe/description on the same scratch
database. Use a direct connection or a session pool; transaction/statement
pooling does not provide this session ownership contract. Every workflow closes
its owner, rolling back any unfinished transaction and releasing the lock.
Failed rollback, unlock or deallocation discards an unsafe native pool client.

## Physical schema comparison

Introspection reads PostgreSQL catalogs for ordinary tables and columns, native
types and type modifiers, defaults, stored generated expressions, primary keys,
unique/check constraints, single-column foreign keys, ordinary indexes, enums
and views. Results use deterministic object/column/constraint ordering. Enum
labels and column names are explicitly converted to text arrays for normal `pg`
decoding on every supported PostgreSQL version.

The desired schema is rendered inside a scratch transaction after temporarily
removing the replayed tables/views/enums. PostgreSQL introspects that desired DDL;
rollback then restores the replayed schema before the diff. This compares native
physical forms, including `varchar`/`character varying`, casts, defaults and view
expressions. It does not copy desired physical facts onto actual introspection.
Application property names and codecs stay in generated source identity;
rename/conversion instructions are excluded from physical equality. Constraint and
index names are compared when the definition explicitly names them; generated
names remain engine-owned, including after a declared column/table rename.
Constraint expressions, columns, uniqueness, methods and predicates remain part
of equality. New related tables are all created before their foreign keys.

Initial tables precede foreign-key additions, permitting references to tables
declared later and mutual references. A composite key renders as one table-level
primary key, preserving its declared column order. Known enum identifiers are
quoted individually, including embedded quotes and reserved URL characters.

This is a supported-declaration comparison, not a model of every PostgreSQL
object. Materialized/partitioned/foreign relations, inheritance, unlogged tables, identity
columns, custom column collations, non-stored generated columns, deferred,
unvalidated or unenforced constraints, NULLS NOT DISTINCT uniqueness,
multi-column/non-default foreign keys, invalid indexes and indexes with included
columns currently produce corrective errors. Standalone
sequences, functions, extension-owned objects, grants and other administrative
objects are outside the snapshot; maintain them explicitly in reviewed SQL.
Additional unsupported physical changes and constraint/index changes require a
manual migration. A failed desired-schema probe or final comparison is never
accepted as an unchanged schema.

## Query metadata without execution

Tooling submits a named protocol Parse, Describe and Sync exchange, followed by
deallocation. It sends no Bind or Execute message. PostgreSQL rejects multiple
commands during Parse; no later statement in a batch can run. Result column names
and native types come from RowDescription and `format_type`, not sampled rows.
Repeated named parameters retain all positional bindings but appear only once
in the generated parameter interface. Duplicate result column names fail with
an explicit alias error rather than producing ambiguous generated properties.
See PostgreSQL's [extended-query message flow](https://www.postgresql.org/docs/16/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY).

RowDescription does not establish expression or outer-join nullability, so every
generated PostgreSQL query column is conservatively nullable. Generated result
types assume the standard `pg` parsers: int8/numeric return strings; date and
timestamp return `Date`; supported integer/float/boolean/text/uuid/bytea types use
their corresponding JavaScript types. JSON and unrecognized/custom/array types
remain `unknown`. Custom pool type parsers and application coercions are caller
contracts and are not inferred by tooling.

## Executed qualification

The real tooling lane exercises alias-target refusal with preserved target data,
unreachable target, read-only reset rollback, deterministic quoted catalogs,
metadata for SELECT and INSERT RETURNING without changing a row or advancing a
sequence, multi-command rejection, error recovery, concurrent descriptions with
pool size one, scratch lock handoff, complete generation/validation/no-op,
stale artifacts, migration drift, failed replay recovery, incremental related
tables, unique-column rename and no-op replay, composite keys, enums,
indexes, checks, views and standard query value types.

The packed contract normally installs minimum `pg@8.23.0` and
`pg-query-stream@4.17.0`, repeats generation/validation/no-op through the installed
public tooling bridge and compiles the generated artifact under TypeScript 6 and 7. CI runs both source and installed workflows on PostgreSQL 16, 17 and 18.

Local integration requires explicit isolated databases:

```sh
ASKR_ORM_TEST_DATABASE_URL=<isolated-target-url> \
ASKR_ORM_TEST_SHADOW_URL=<disposable-scratch-url> \
vp env exec --node 24.21.0 npm run test:integration
```

Ordinary package tests skip these native PostgreSQL cases without both URLs.
The explicit integration command rejects missing URLs instead of passing skips.
No release version, tag or publication is included in this change.
