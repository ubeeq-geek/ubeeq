declare module "node:sqlite" {
  interface StatementSync {
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): { changes: number };
  }
  export class DatabaseSync {
    constructor(path: string);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
