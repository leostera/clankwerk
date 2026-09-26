export interface SourceMetadata {
    readonly repository?: string;
    readonly commitSha?: string;
    readonly branch?: string;
    readonly dirty?: boolean;
    readonly packagePath?: string;
    readonly deployedAt: number;
}
export interface SchedulerDeployment {
    readonly id: string;
    readonly runtime: "local" | "cloudflare" | string;
    readonly source: SourceMetadata;
    readonly startedAt: number;
    readonly activatedAt?: number;
}