import { jsx as _jsx } from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./Dashboard.js";
import { RunGraph } from "./RunGraph.js";
const root = document.getElementById("root");
if (!root)
    throw new Error("Missing #root");
const appRoot = createRoot(root);
const render = () => {
    const match = window.location.hash.match(/^#\/runs\/([^/]+)$/);
    appRoot.render(match ? _jsx(RunGraph, { runId: decodeURIComponent(match[1]) }) : _jsx(Dashboard, {}));
};
window.addEventListener("hashchange", render);
render();