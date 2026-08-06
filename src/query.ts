import type { DatabaseAdapter, QueryOptions } from "./adapter";
import { normalizeDatabaseError } from "./errors";
import { quoteIdentifier } from "./naming";
import type { AnyTable, ColumnValue, InferRow } from "./schema";
import {
  compileSql,
  type ColumnRef,
  type Expression,
  type SqlFragment,
  type SqlQuery,
  tableRefs,
} from "./sql";

export type Selection = Readonly<Record<string, Expression>>;
export type SelectionResult<S extends Selection> = Readonly<{
  [K in keyof S]: S[K] extends Expression<infer T> ? T : never;
}>;

export type References<T extends AnyTable, Alias extends string> = Readonly<
  Record<
    Alias,
    {
      readonly [K in keyof T["$columns"]]: ColumnRef<ColumnValue<T["$columns"][K]>>;
    }
  >
>;

type AnyReferences = Readonly<Record<string, Readonly<Record<string, ColumnRef>>>>;

export interface JoinTarget<T extends AnyTable = AnyTable> {
  readonly definition: T;
}

interface JoinState {
  readonly type: "INNER" | "LEFT" | "RIGHT" | "FULL";
  readonly table: AnyTable;
  readonly alias: string;
  readonly on: SqlFragment<boolean>;
}

interface QueryState {
  readonly source: AnyTable;
  readonly sourceAlias: string;
  readonly references: AnyReferences;
  readonly joins: readonly JoinState[];
  readonly selection?: Selection;
  readonly predicates: readonly SqlFragment<boolean>[];
  readonly groups: readonly Expression[];
  readonly having?: SqlFragment<boolean>;
  readonly order: readonly {
    readonly expression: Expression;
    readonly direction: "ASC" | "DESC";
  }[];
  readonly limit?: number;
  readonly offset?: number;
  readonly distinct: boolean;
  readonly ctes: readonly { readonly name: string; readonly query: SqlQuery }[];
}

function qualifiedTable(table: AnyTable): string {
  return `${quoteIdentifier(table.$schema)}.${quoteIdentifier(table.$name)}`;
}

function expressionQuery(expression: Expression): SqlQuery {
  if ((expression as ColumnRef).kind === "column-ref") {
    const ref = expression as ColumnRef;
    return {
      text: `${quoteIdentifier(ref.tableAlias)}.${quoteIdentifier(ref.columnName)}`,
      values: [],
    };
  }
  return compileSql(expression as SqlFragment);
}

function appendQuery(target: { text: string; values: unknown[] }, query: SqlQuery): void {
  const offset = target.values.length;
  target.text += query.text.replace(/\$(\d+)/g, (_match, index: string) => {
    return `$${Number(index) + offset}`;
  });
  target.values.push(...query.values);
}

function compileState(state: QueryState): {
  readonly query: SqlQuery;
  readonly aliases: readonly string[];
} {
  const output = { text: "", values: [] as unknown[] };
  if (state.ctes.length > 0) {
    output.text += "WITH ";
    state.ctes.forEach((cte, index) => {
      if (index > 0) output.text += ", ";
      output.text += `${quoteIdentifier(cte.name)} AS (`;
      appendQuery(output, cte.query);
      output.text += ")";
    });
    output.text += " ";
  }
  output.text += `SELECT${state.distinct ? " DISTINCT" : ""} `;
  const selection =
    state.selection ??
    Object.fromEntries(
      Object.entries(state.source.$columns).map(([property, column]) => [
        property,
        {
          kind: "column-ref",
          tableAlias: state.sourceAlias,
          columnName: column.ast.name,
        } satisfies ColumnRef,
      ]),
    );
  const aliases = Object.keys(selection);
  Object.entries(selection).forEach(([alias, expression], index) => {
    if (index > 0) output.text += ", ";
    appendQuery(output, expressionQuery(expression));
    output.text += ` AS ${quoteIdentifier(alias)}`;
  });
  output.text += ` FROM ${qualifiedTable(state.source)} AS ${quoteIdentifier(state.sourceAlias)}`;
  for (const join of state.joins) {
    output.text += ` ${join.type} JOIN ${qualifiedTable(join.table)} AS ${quoteIdentifier(join.alias)} ON `;
    appendQuery(output, compileSql(join.on));
  }
  if (state.predicates.length > 0) {
    output.text += " WHERE ";
    state.predicates.forEach((predicate, index) => {
      if (index > 0) output.text += " AND ";
      output.text += "(";
      appendQuery(output, compileSql(predicate));
      output.text += ")";
    });
  }
  if (state.groups.length > 0) {
    output.text += " GROUP BY ";
    state.groups.forEach((group, index) => {
      if (index > 0) output.text += ", ";
      appendQuery(output, expressionQuery(group));
    });
  }
  if (state.having) {
    output.text += " HAVING ";
    appendQuery(output, compileSql(state.having));
  }
  if (state.order.length > 0) {
    output.text += " ORDER BY ";
    state.order.forEach((entry, index) => {
      if (index > 0) output.text += ", ";
      appendQuery(output, expressionQuery(entry.expression));
      output.text += ` ${entry.direction}`;
    });
  }
  if (state.limit !== undefined) {
    if (!Number.isSafeInteger(state.limit) || state.limit < 0) throw new Error("Invalid LIMIT.");
    output.text += ` LIMIT ${state.limit}`;
  }
  if (state.offset !== undefined) {
    if (!Number.isSafeInteger(state.offset) || state.offset < 0) throw new Error("Invalid OFFSET.");
    output.text += ` OFFSET ${state.offset}`;
  }
  return { query: output, aliases };
}

function mapRows<Row>(
  rows: readonly Record<string, unknown>[],
  aliases: readonly string[],
): readonly Row[] {
  return rows.map((row) =>
    Object.freeze(Object.fromEntries(aliases.map((alias) => [alias, row[alias]]))),
  ) as unknown as readonly Row[];
}

export class SelectQuery<Row, Refs extends AnyReferences> {
  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly state: QueryState,
  ) {}

  where(
    predicate: SqlFragment<boolean> | ((refs: Refs) => SqlFragment<boolean>),
  ): SelectQuery<Row, Refs> {
    const resolved =
      typeof predicate === "function" ? predicate(this.state.references as Refs) : predicate;
    return new SelectQuery(this.adapter, {
      ...this.state,
      predicates: [...this.state.predicates, resolved],
    });
  }

  groupBy(
    ...groups: readonly (Expression | ((refs: Refs) => Expression))[]
  ): SelectQuery<Row, Refs> {
    return new SelectQuery(this.adapter, {
      ...this.state,
      groups: [
        ...this.state.groups,
        ...groups.map((group) =>
          typeof group === "function" ? group(this.state.references as Refs) : group,
        ),
      ],
    });
  }

  having(
    predicate: SqlFragment<boolean> | ((refs: Refs) => SqlFragment<boolean>),
  ): SelectQuery<Row, Refs> {
    return new SelectQuery(this.adapter, {
      ...this.state,
      having:
        typeof predicate === "function" ? predicate(this.state.references as Refs) : predicate,
    });
  }

  orderBy(
    expression: Expression | ((refs: Refs) => Expression),
    direction: "asc" | "desc" = "asc",
  ): SelectQuery<Row, Refs> {
    return new SelectQuery(this.adapter, {
      ...this.state,
      order: [
        ...this.state.order,
        {
          expression:
            typeof expression === "function"
              ? expression(this.state.references as Refs)
              : expression,
          direction: direction.toUpperCase() as "ASC" | "DESC",
        },
      ],
    });
  }

  limit(value: number): SelectQuery<Row, Refs> {
    return new SelectQuery(this.adapter, { ...this.state, limit: value });
  }

  offset(value: number): SelectQuery<Row, Refs> {
    return new SelectQuery(this.adapter, { ...this.state, offset: value });
  }

  distinct(): SelectQuery<Row, Refs> {
    return new SelectQuery(this.adapter, { ...this.state, distinct: true });
  }

  with(name: string, query: { toSQL(): SqlQuery }): SelectQuery<Row, Refs> {
    return new SelectQuery(this.adapter, {
      ...this.state,
      ctes: [...this.state.ctes, { name, query: query.toSQL() }],
    });
  }

  select<const S extends Selection>(
    projection: S | ((refs: Refs) => S),
  ): SelectQuery<SelectionResult<S>, Refs> {
    return new SelectQuery(this.adapter, {
      ...this.state,
      selection:
        typeof projection === "function" ? projection(this.state.references as Refs) : projection,
    });
  }

  join<T extends AnyTable, A extends string = T["$name"]>(
    target: JoinTarget<T>,
    options: { readonly as?: A } = {},
  ): PendingJoin<Row, Refs, T, false, A, false> {
    return new PendingJoin(this.adapter, this.state, target.definition, options.as, "INNER");
  }

  leftJoin<T extends AnyTable, A extends string = T["$name"]>(
    target: JoinTarget<T>,
    options: { readonly as?: A } = {},
  ): PendingJoin<Row, Refs, T, true, A, false> {
    return new PendingJoin(this.adapter, this.state, target.definition, options.as, "LEFT");
  }

  rightJoin<T extends AnyTable, A extends string = T["$name"]>(
    target: JoinTarget<T>,
    options: { readonly as?: A } = {},
  ): PendingJoin<Row, Refs, T, false, A, true> {
    return new PendingJoin(this.adapter, this.state, target.definition, options.as, "RIGHT");
  }

  fullJoin<T extends AnyTable, A extends string = T["$name"]>(
    target: JoinTarget<T>,
    options: { readonly as?: A } = {},
  ): PendingJoin<Row, Refs, T, true, A, true> {
    return new PendingJoin(this.adapter, this.state, target.definition, options.as, "FULL");
  }

  toSQL(): SqlQuery {
    return compileState(this.state).query;
  }

  async execute(options: QueryOptions = {}): Promise<readonly Row[]> {
    const compiled = compileState(this.state);
    try {
      const result = await this.adapter.execute<Record<string, unknown>>(compiled.query, options);
      return mapRows<Row>(result.rows, compiled.aliases);
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async first(options: QueryOptions = {}): Promise<Row | null> {
    return (await this.limit(1).execute(options))[0] ?? null;
  }

  prepare(name: string): PreparedQuery<Row> {
    const compiled = compileState(this.state);
    return {
      name,
      toSQL: () => compiled.query,
      execute: async (options = {}) => {
        try {
          const result = await this.adapter.execute<Record<string, unknown>>(compiled.query, {
            ...options,
            preparedName: name,
          });
          return mapRows<Row>(result.rows, compiled.aliases);
        } catch (error) {
          throw normalizeDatabaseError(error);
        }
      },
    };
  }

  stream(options: QueryOptions = {}): AsyncIterable<Row> {
    if (!this.adapter.stream) {
      throw new Error("This database adapter does not support streaming.");
    }
    const compiled = compileState(this.state);
    const source = this.adapter.stream<Record<string, unknown>>(compiled.query, options);
    const aliases = compiled.aliases;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const row of source) {
            yield mapRows<Row>([row], aliases)[0] as Row;
          }
        } catch (error) {
          throw normalizeDatabaseError(error);
        }
      },
    };
  }
}

type JoinedRefs<
  Refs extends AnyReferences,
  T extends AnyTable,
  Alias extends string,
  Nullable extends boolean,
> = Refs &
  Readonly<
    Record<
      Alias,
      {
        readonly [K in keyof T["$columns"]]: ColumnRef<
          ColumnValue<T["$columns"][K]> | (Nullable extends true ? null : never)
        >;
      }
    >
  >;

type NullableReferences<Refs extends AnyReferences> = {
  readonly [Alias in keyof Refs]: {
    readonly [K in keyof Refs[Alias]]: Refs[Alias][K] extends ColumnRef<infer Value>
      ? ColumnRef<Value | null>
      : never;
  };
};

type ExistingJoinRefs<Refs extends AnyReferences, Nullable extends boolean> = Nullable extends true
  ? NullableReferences<Refs>
  : Refs;

export class PendingJoin<
  _Row,
  Refs extends AnyReferences,
  T extends AnyTable,
  Nullable extends boolean,
  Alias extends string,
  ExistingNullable extends boolean,
> {
  private readonly alias: Alias;

  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly state: QueryState,
    private readonly table: T,
    alias: Alias | undefined,
    private readonly type: JoinState["type"],
  ) {
    this.alias = (alias ?? table.$name) as Alias;
    if (this.alias in state.references) {
      throw new Error(`Duplicate table alias ${this.alias}; self-joins require an explicit alias.`);
    }
  }

  on(
    predicate: (
      refs: JoinedRefs<ExistingJoinRefs<Refs, ExistingNullable>, T, Alias, Nullable>,
    ) => SqlFragment<boolean>,
  ): JoinedQuery<JoinedRefs<ExistingJoinRefs<Refs, ExistingNullable>, T, Alias, Nullable>> {
    const references = {
      ...this.state.references,
      [this.alias]: tableRefs(this.table, this.alias),
    };
    const on = predicate(
      references as JoinedRefs<ExistingJoinRefs<Refs, ExistingNullable>, T, Alias, Nullable>,
    );
    const { selection: _selection, ...stateWithoutSelection } = this.state;
    return new JoinedQuery(this.adapter, {
      ...stateWithoutSelection,
      references,
      joins: [...this.state.joins, { type: this.type, table: this.table, alias: this.alias, on }],
    });
  }
}

export class JoinedQuery<Refs extends AnyReferences> {
  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly state: QueryState,
  ) {}

  select<const S extends Selection>(
    projection: S | ((refs: Refs) => S),
  ): SelectQuery<SelectionResult<S>, Refs> {
    return new SelectQuery(this.adapter, {
      ...this.state,
      selection:
        typeof projection === "function" ? projection(this.state.references as Refs) : projection,
    });
  }

  join<T extends AnyTable, A extends string = T["$name"]>(
    target: JoinTarget<T>,
    options: { readonly as?: A } = {},
  ): PendingJoin<never, Refs, T, false, A, false> {
    return new PendingJoin(this.adapter, this.state, target.definition, options.as, "INNER");
  }

  leftJoin<T extends AnyTable, A extends string = T["$name"]>(
    target: JoinTarget<T>,
    options: { readonly as?: A } = {},
  ): PendingJoin<never, Refs, T, true, A, false> {
    return new PendingJoin(this.adapter, this.state, target.definition, options.as, "LEFT");
  }

  rightJoin<T extends AnyTable, A extends string = T["$name"]>(
    target: JoinTarget<T>,
    options: { readonly as?: A } = {},
  ): PendingJoin<never, Refs, T, false, A, true> {
    return new PendingJoin(this.adapter, this.state, target.definition, options.as, "RIGHT");
  }

  fullJoin<T extends AnyTable, A extends string = T["$name"]>(
    target: JoinTarget<T>,
    options: { readonly as?: A } = {},
  ): PendingJoin<never, Refs, T, true, A, true> {
    return new PendingJoin(this.adapter, this.state, target.definition, options.as, "FULL");
  }
}

export interface PreparedQuery<Row> {
  readonly name: string;
  toSQL(): SqlQuery;
  execute(options?: QueryOptions): Promise<readonly Row[]>;
}

export function tableQuery<T extends AnyTable>(
  adapter: DatabaseAdapter,
  definition: T,
): SelectQuery<InferRow<T>, References<T, T["$name"]>> {
  const alias = definition.$name;
  return new SelectQuery(adapter, {
    source: definition,
    sourceAlias: alias,
    references: { [alias]: tableRefs(definition, alias) },
    joins: [],
    predicates: [],
    groups: [],
    order: [],
    distinct: false,
    ctes: [],
  });
}
