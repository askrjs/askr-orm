import type { QueryOptions } from "./adapter";
import type { SqlQuery } from "./sql";

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

export type RegisteredQueryFunction<P extends Record<string, unknown>, Row> = (
  params: P,
  options?: QueryOptions,
) => Promise<readonly Row[]>;

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
