import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
/** Serves the compiled React client shipped with @libclank/ui. */
export const createDashboardAssetHandler = (root = resolve(dirname(new URL(import.meta.url).pathname), "client")) => async (request) => {
    const url = new URL(request.url);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    if (requested.includes(".."))
        return new Response("Not found", { status: 404 });
    try {
        const body = await readFile(join(root, requested));
        return new Response(body, {
            headers: {
                "content-type": contentType(requested),
                "cache-control": requested === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
            },
        });
    }
    catch {
        return new Response("Not found", { status: 404 });
    }
};
function contentType(path) {
    return path.endsWith(".html")
        ? "text/html; charset=utf-8"
        : path.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : path.endsWith(".css")
                ? "text/css; charset=utf-8"
                : "application/octet-stream";
}