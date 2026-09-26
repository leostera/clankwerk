export { createDashboardApi } from "./api.js";
export { createDashboardAssetHandler } from "./server.js";
export { Dashboard } from "./Dashboard.js";
export { RunGraph } from "./RunGraph.js";
export { ClankerDashboard } from "./ClankerDashboard.js";
/** HTML shell for the bundled React dashboard client. */
export const reactDashboardHtml = (scriptPath = "/ui.js") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LibClank</title></head><body><div id="root"></div><script type="module" src="${scriptPath}"></script></body></html>`;
/** Read-only operational dashboard handler. Workflow authoring is intentionally absent. */
export const createDashboardHandler = (operations, basePath = "/api") => async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/")
        return new Response(dashboardHtml(basePath), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (request.method !== "GET" || !url.pathname.startsWith(basePath))
        return new Response("Not found", { status: 404 });
    const path = url.pathname.slice(basePath.length).replace(/^\//, "");
    if (path === "workflows")
        return json(await operations.listWorkflows());
    if (path === "runs")
        return json(await operations.listRuns());
    const match = path.match(/^runs\/([^/]+)(\/events|\/nodes)?$/);
    if (match) {
        const runId = match[1];
        if (match[2] === "/events")
            return json(await operations.getEvents(runId));
        if (match[2] === "/nodes")
            return json(await operations.getNodes(runId));
        return json(await operations.getRun(runId));
    }
    return new Response("Not found", { status: 404 });
};
export const dashboardHtml = (apiPath = "/api") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LibClank Runs</title><style>${styles}</style></head><body><main><header><h1>LibClank</h1><p>Workflow operations</p></header><section><h2>Runs</h2><div id="runs">Loading…</div></section></main><script>const api=${JSON.stringify(apiPath)};const esc=(s)=>String(s??"").replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));async function load(){const runs=await fetch(api+'/runs').then(r=>r.json());document.querySelector('#runs').innerHTML=runs.map(r=>'<article><strong>'+esc(r.status)+'</strong><code>'+esc(r.id)+'</code><small>'+new Date(r.createdAt).toLocaleString()+'</small><a href="'+api+'/runs/'+encodeURIComponent(r.id)+'/nodes">nodes</a></article>').join('')||'<p>No runs yet.</p>'}load();setInterval(load,5000)</script></body></html>`;
function json(value) {
    return Response.json(value, { headers: { "cache-control": "no-store" } });
}
const styles = "body{font:16px system-ui;margin:0;background:#f6f7f9;color:#17202a}main{max-width:960px;margin:auto;padding:32px}header{margin-bottom:32px}h1{margin-bottom:4px}section{background:white;border:1px solid #ddd;border-radius:12px;padding:20px}article{display:grid;grid-template-columns:120px 1fr 190px 80px;gap:12px;padding:14px 0;border-bottom:1px solid #eee;align-items:center}article:last-child{border-bottom:0}code,small{color:#667085}a{color:#2563eb}";