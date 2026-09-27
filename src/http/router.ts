import type { z } from "zod";

export type Handler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;

type Route = { method: string; pattern: RegExp; handler: Handler };

export type ErrorIssue = { path: string; message: string };

/** An expected, client-visible failure. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: ErrorIssue[],
  ) {
    super(message);
  }
}

export class Router {
  private readonly routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const pattern = new RegExp("^" + path.replace(/:([a-zA-Z]+)/g, "(?<$1>[^/]+)") + "$");
    this.routes.push({ method, pattern, handler });
    return this;
  }

  /** Undefined when no route matches, so the caller can fall through to static files. */
  match(req: Request): { handler: Handler; params: Record<string, string>; route: string } | "method_not_allowed" | undefined {
    const { pathname } = new URL(req.url);
    let pathMatched = false;
    for (const route of this.routes) {
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(match.groups ?? {})) params[key] = decodeURIComponent(value);
      return { handler: route.handler, params, route: `${route.method} ${route.pattern.source}` };
    }
    return pathMatched ? "method_not_allowed" : undefined;
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(error: HttpError): Response {
  const issues = error.issues ? { issues: error.issues } : {};
  return json({ error: { code: error.code, message: error.message, ...issues } }, error.status);
}

const BODY_LIMIT_BYTES = 128 * 1024;

export async function readBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Envie application/json.");
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Corpo da requisição grande demais.");
  }
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > BODY_LIMIT_BYTES) throw new HttpError(413, "BODY_TOO_LARGE", "Corpo da requisição grande demais.");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "JSON inválido.");
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new HttpError(
      422,
      "INVALID_REQUEST",
      "Requisição inválida.",
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return parsed.data;
}
