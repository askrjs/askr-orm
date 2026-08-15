import type { QueryOptions } from "./adapter";
import type { SqlQuery } from "./sql";

/** A precompiled, named SQL query template produced by {@link defineQuery}. */
export interface RegisteredQuery<
  Params extends Record<string, unknown>,
  Row = Record<string, unknown>,
> {
  readonly kind: "registered-query";
  readonly key: string;
  readonly strings: readonly string[];
  readonly parameters: readonly (keyof Params & string)[];
  compile(params: Params): SqlQuery;
  /** Type-only result marker populated by generated query metadata. */
  readonly _row?: Row;
}

/** Shape of the callable exposed on `client.queries[name]` for a {@link RegisteredQuery}. */
export type RegisteredQueryFunction<P extends Record<string, unknown>, Row> = (
  params: P,
  options?: QueryOptions,
) => Promise<readonly Row[]>;

/**
 * Creates a tagged-template builder for a named, parameterized SQL query. The returned function
 * is used as a template tag, e.g. `defineQuery<Params>("byId")\`SELECT * FROM t WHERE id = ${"id"}\``,
 * where interpolated values must be parameter names from `Params`.
 *
 * @throws If `key` is empty, or a template substitution is not a parameter name.
 */
export function defineQuery<Params extends Record<string, unknown>>(key: string) {
  if (!key.trim()) throw new Error("Registered query keys cannot be empty.");
  return (strings: TemplateStringsArray, ...parameters: readonly (keyof Params & string)[]) => {
    if (parameters.some((name) => typeof name !== "string")) {
      throw new Error("defineQuery substitutions must be parameter names.");
    }
    return {
      kind: "registered-query" as const,
      key,
      strings: [...strings],
      parameters,
      compile(params: Params): SqlQuery {
        const values: unknown[] = [];
        let text = strings[0] ?? "";
        parameters.forEach((name, index) => {
          if (!(name in params)) throw new Error(`Missing registered query parameter ${name}.`);
          values.push(params[name]);
          text += `$${index + 1}${strings[index + 1] ?? ""}`;
        });
        return { text, values };
      },
    } satisfies RegisteredQuery<Params>;
  };
}
