// Types for the part of better-sqlite3 13.0.3 that core uses. The package ships no types; these are written from its
// lib/ and docs/api.md, and cover only what platform/db calls, so a new use is checked against the docs first.

declare module 'better-sqlite3' {
  export interface RunResult {
    changes: number
    lastInsertRowid: number | bigint
  }

  export interface Statement<P extends unknown[] = unknown[], R = unknown> {
    readonly source: string
    /** The statement returns rows. */
    readonly reader: boolean
    run(...params: P): RunResult
    get(...params: P): R | undefined
    all(...params: P): R[]
    /** Returns only the first column of each row. */
    pluck(on?: boolean): this
  }

  export interface Transaction<F extends (...args: never[]) => unknown> {
    (...args: Parameters<F>): ReturnType<F>
    deferred(...args: Parameters<F>): ReturnType<F>
    immediate(...args: Parameters<F>): ReturnType<F>
    exclusive(...args: Parameters<F>): ReturnType<F>
  }

  export interface Options {
    readonly?: boolean
    fileMustExist?: boolean
    /** busy timeout, ms */
    timeout?: number
    /** Path of the `.node` to load instead of the package's prebuild lookup. */
    nativeBinding?: string
  }

  export interface Database {
    readonly name: string
    readonly open: boolean
    readonly inTransaction: boolean
    readonly memory: boolean
    prepare<P extends unknown[] = unknown[], R = unknown>(sql: string): Statement<P, R>
    exec(sql: string): this
    /** `simple`: the first column of the first row. */
    pragma(source: string, options?: { simple?: boolean }): unknown
    transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>
    /** The database as a buffer (tests). */
    serialize(): Buffer
    close(): this
  }

  interface DatabaseConstructor {
    new (filename?: string | Buffer, options?: Options): Database
  }

  const Database: DatabaseConstructor
  export default Database
}
