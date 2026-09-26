export const SCHEDULER_MIGRATIONS = [
    {
        version: 1,
        statements: [
            `CREATE TABLE IF NOT EXISTS workflow_definitions (
        definition_hash TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        registered_at INTEGER NOT NULL
      )`,
            `CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY,
        definition_hash TEXT NOT NULL REFERENCES workflow_definitions(definition_hash),
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
            `CREATE TABLE IF NOT EXISTS node_instances (
        instance_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        input_artifacts_json TEXT NOT NULL,
        output_json TEXT,
        output_artifacts_json TEXT,
        execution_key TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        lease_expires_at INTEGER,
        error_json TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(run_id, instance_id)
      )`,
            "CREATE INDEX IF NOT EXISTS node_instances_ready ON node_instances(status, next_attempt_at)",
            "CREATE INDEX IF NOT EXISTS node_instances_cache ON node_instances(execution_key, status)",
            `CREATE TABLE IF NOT EXISTS node_dependencies (
        run_id TEXT NOT NULL,
        node_instance_id TEXT NOT NULL REFERENCES node_instances(instance_id),
        depends_on_instance_id TEXT NOT NULL REFERENCES node_instances(instance_id),
        PRIMARY KEY (run_id, node_instance_id, depends_on_instance_id)
      )`,
            `CREATE TABLE IF NOT EXISTS scheduler_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
        ],
    },
    {
        version: 2,
        statements: [
            `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`,
            `CREATE TABLE IF NOT EXISTS scheduler_deployments (
        deployment_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        source_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        activated_at INTEGER
      )`,
            `CREATE TABLE IF NOT EXISTS active_workflow_definitions (
        workflow_id TEXT PRIMARY KEY,
        definition_hash TEXT NOT NULL REFERENCES workflow_definitions(definition_hash),
        deployment_id TEXT NOT NULL REFERENCES scheduler_deployments(deployment_id),
        activated_at INTEGER NOT NULL
      )`,
        ],
    },
];
export const applyMigrations = (executor) => {
    executor.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const applied = new Set(executor.appliedVersions());
    for (const migration of SCHEDULER_MIGRATIONS) {
        if (applied.has(migration.version))
            continue;
        for (const statement of migration.statements)
            executor.exec(statement);
        executor.record(migration.version);
    }
};