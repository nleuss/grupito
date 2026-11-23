/** Replaced at build time: true in test builds (dist-test/). */
declare const __TEST__: boolean;

declare module '*.css' {
  const content: string;
  export default content;
}

declare module 'kuromoji/src/loader/BrowserDictionaryLoader';
declare module 'kuromoji' {
  const kuromoji: { builder(opts: { dicPath: string }): { build(cb: (err: unknown, tokenizer: any) => void): void } };
  export default kuromoji;
}

declare module 'sql.js' {
  export interface Database {
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    prepare(sql: string): { run(params?: unknown[]): void; free(): void };
    export(): Uint8Array;
    close(): void;
  }
  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string; wasmBinary?: ArrayBuffer | Uint8Array }): Promise<SqlJsStatic>;
}
