import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { BrowserRouter, NavLink, Route, Routes } from "react-router";
import { useEffect, useState } from "react";
import "./clanker-dashboard.css";
/** Reusable LibClank operations console. Applications supply only their API base and title. */
export const ClankerDashboard = ({ apiBase = "/api", title = "Clanker" }) => (_jsx(BrowserRouter, { children: _jsxs("div", { className: "clanker-shell", children: [_jsxs("header", { className: "clanker-masthead", children: [_jsxs(NavLink, { className: "clanker-wordmark", to: "/", children: [title, " / Operations"] }), _jsxs("nav", { "aria-label": "Primary navigation", children: [_jsx(NavLink, { to: "/", children: "Dashboard" }), _jsx(NavLink, { to: "/workflows", children: "Workflows" }), _jsx(NavLink, { to: "/runs", children: "Runs" })] })] }), _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(Dashboard, { apiBase: apiBase }) }), _jsx(Route, { path: "/workflows", element: _jsx(Workflows, { apiBase: apiBase }) }), _jsx(Route, { path: "/runs", element: _jsx(Runs, { apiBase: apiBase }) })] })] }) }));
const Dashboard = ({ apiBase }) => (_jsxs("main", { children: [_jsxs("div", { className: "clanker-heading", children: [_jsx("p", { className: "clanker-eyebrow", children: "Operations / Cloudflare" }), _jsx("h1", { children: "Dashboard" })] }), _jsxs("div", { className: "clanker-grid", children: [_jsxs("section", { children: [_jsx("p", { className: "clanker-label", children: "01 / Workflows" }), _jsx(Workflows, { apiBase: apiBase, compact: true })] }), _jsxs("section", { children: [_jsx("p", { className: "clanker-label", children: "02 / Recent runs" }), _jsx(Runs, { apiBase: apiBase, compact: true })] })] })] }));
const Workflows = ({ apiBase, compact = false }) => {
    const [workflows, setWorkflows] = useState([]);
    useEffect(() => {
        void fetch(`${apiBase}/workflows`)
            .then((response) => response.json())
            .then((value) => setWorkflows(value));
    }, [apiBase]);
    return (_jsxs("main", { className: compact ? "clanker-compact" : "", children: [!compact && (_jsxs("div", { className: "clanker-heading", children: [_jsx("p", { className: "clanker-eyebrow", children: "Operations / Definitions" }), _jsx("h1", { children: "Workflows" })] })), _jsxs("div", { children: [workflows.map((workflow) => (_jsxs("article", { className: "clanker-workflow", children: [_jsx("span", { children: workflow.id }), _jsx("code", { children: workflow.triggers.map((trigger) => trigger.path ?? trigger.id).join(" · ") })] }, workflow.id))), workflows.length === 0 && _jsx("p", { className: "clanker-muted", children: "No workflows registered." })] })] }));
};
const Runs = ({ apiBase, compact = false }) => {
    const [runs, setRuns] = useState([]);
    useEffect(() => {
        const load = () => void fetch(`${apiBase}/runs`)
            .then((response) => response.json())
            .then((value) => setRuns(value));
        load();
        const timer = setInterval(load, 5000);
        return () => clearInterval(timer);
    }, [apiBase]);
    return (_jsxs("main", { className: compact ? "clanker-compact" : "", children: [!compact && (_jsxs("div", { className: "clanker-heading", children: [_jsx("p", { className: "clanker-eyebrow", children: "Operations / History" }), _jsx("h1", { children: "Runs" })] })), _jsxs("div", { children: [runs.map((run) => (_jsxs("article", { className: "clanker-run", children: [_jsx("span", { className: `clanker-status clanker-status-${run.status}`, children: run.status }), _jsx("span", { children: run.workflowId }), _jsx("time", { children: new Date(run.updatedAt).toLocaleString() })] }, run.runId))), runs.length === 0 && _jsx("p", { className: "clanker-muted", children: "No runs yet." })] })] }));
};