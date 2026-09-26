import { type ReactElement } from "react";
export interface DashboardProps {
    readonly apiBase?: string;
}
/** React operational dashboard. It only reads and operates on existing runs. */
export declare const Dashboard: ({ apiBase }: DashboardProps) => ReactElement;