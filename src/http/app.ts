import type { Logger } from "../logger.ts";
import { HttpError, errorResponse, type Router } from "./router.ts";

export type Asset = { body: string; type: string };

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

const STATIC_HEADERS = {
  "cache-control": "no-cache",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function createApp(api: Router, assets: Map<string, Asset>, logger: Logger) {
  return async function fetch(req: Request): Promise<Response> {
    const started = performance.now();
    const incoming = req.headers.get("x-request-id");
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
    const { pathname } = new URL(req.url);

    const response = await route(req, pathname, requestId);
    response.headers.set("x-request-id", requestId);

    const durationMs = Math.round(performance.now() - started);
    if (pathname.startsWith("/api/")) {
      logger.info("request_completed", { requestId, method: req.method, path: pathname, status: response.status, durationMs });
    }
    return response;
  };

  async function route(req: Request, pathname: string, requestId: string): Promise<Response> {
    const matched = api.match(req);
    if (matched === "method_not_allowed") {
      return errorResponse(new HttpError(405, "METHOD_NOT_ALLOWED", "Método não permitido."));
    }
    if (matched) {
      try {
        return await matched.handler(req, matched.params);
      } catch (error) {
        if (error instanceof HttpError) return errorResponse(error);
        logger.error("unexpected_error", { requestId, path: pathname, error: error instanceof Error ? error.name : "unknown" });
        return errorResponse(new HttpError(500, "INTERNAL_ERROR", "Erro interno."));
      }
    }
    const asset = req.method === "GET" ? assets.get(pathname === "/" ? "/index.html" : pathname) : undefined;
    if (!asset) return errorResponse(new HttpError(404, "NOT_FOUND", "Recurso não encontrado."));
    return new Response(asset.body, { headers: { "content-type": asset.type, ...STATIC_HEADERS } });
  }
}
