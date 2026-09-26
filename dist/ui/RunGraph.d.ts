import { type ReactElement } from "react";
import "@xyflow/react/dist/style.css";
export interface RunGraphProps {
    readonly runId: string;
    readonly apiBase?: string;
}
/** React Flow execution graph. It is read-only and reflects persisted node state. */
export declare const RunGraph: ({ runId, apiBase }: RunGraphProps) => ReactElement;