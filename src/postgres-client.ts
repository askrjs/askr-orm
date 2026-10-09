import type { PoolClient, QueryResult } from "pg";
import { normalizeDatabaseError, type DatabaseError } from "./errors";

export class CheckedOutClient {
  private failure: DatabaseError | undefined;

  private readonly onError = (error: Error): void => {
    this.failure ??= normalizeDatabaseError(error);
  };

  constructor(private readonly client: PoolClient) {
    client.on("error", this.onError);
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
  }

  async query(config: unknown): Promise<QueryResult> {
    this.assertHealthy();
    try {
      const result = await this.client.query(config as never);
      this.assertHealthy();
      return result;
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  startStream<T>(query: T): T {
    this.assertHealthy();
    return this.client.query(query as never) as T;
  }

  async cleanup(statement: string): Promise<void> {
    try {
      await this.query(statement);
    } catch (error) {
      // A failed rollback/unlock cannot leave a reusable pooled connection.
      this.failure ??= normalizeDatabaseError(error);
    }
  }

  release(error?: unknown): void {
    if (error !== undefined) this.failure ??= normalizeDatabaseError(error);
    this.client.off("error", this.onError);
    this.client.release(this.failure);
  }
}
