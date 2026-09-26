export interface SqlMigration {
    readonly version: number;
    readonly statements: readonly string[];
}
export interface SqlMigrationExecutor {
    exec(sql: string): void;
    appliedVersions(): readonly number[];
    record(version: number): void;
}
export declare const SCHEDULER_MIGRATIONS: readonly SqlMigration[];
export declare const applyMigrations: (executor: SqlMigrationExecutor) => void;