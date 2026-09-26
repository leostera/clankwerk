import { type ReactElement } from "react";
import "./clanker-dashboard.css";
export interface ClankerDashboardProps {
    readonly apiBase?: string;
    readonly title?: string;
}
/** Reusable LibClank operations console. Applications supply only their API base and title. */
export declare const ClankerDashboard: ({ apiBase, title }: ClankerDashboardProps) => ReactElement;