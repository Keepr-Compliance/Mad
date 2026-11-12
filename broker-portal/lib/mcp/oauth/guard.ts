/**
 * Shared wrapper for the OAuth routes (BACKLOG-4238).
 *
 * Order: configuration ('off' → 404, 'misconfigured' → 503) → method (405 +
 * Allow) → the route's handler inside a try/catch. The catch answers with a
 * static 503 body, logs the error name only, sends Sentry one static message
 * with the route and the error name, and never rethrows.
 *
 * Every method is exported explicitly by each route, so Next never maps a
 * missing HEAD onto GET. HEAD on a GET route runs the GET handler and drops
 * the body.
 */

import * as Sentry from '@sentry/nextjs';
import { oauthConfig, type OAuthConfig } from './config';
import { ALL_METHODS, methodNotAllowed, oauthError, withoutBody, type HttpMethod } from './http';
import { errorNameTag, logOutcome, type Outcome } from './log';

export type OkConfig = Extract<OAuthConfig, { state: 'ok' }>;

/** Filled in by a handler; the guard writes it as the request's single log line. */
export type LogFields = Partial<Pick<Outcome, 'outcome' | 'keys' | 'otherKeys' | 'error'>>;

export type OAuthHandler = (_req: Request, _cfg: OkConfig, _log: LogFields) => Promise<Response>;

export type RouteName = 'metadata' | 'resource-metadata' | 'register';

export type RouteHandlers = Record<HttpMethod, (_req: Request) => Promise<Response>>;

export const ROUTE_ERROR_MESSAGE = 'mcp-oauth route error';

export function withOAuthRoute(route: RouteName, allowed: readonly HttpMethod[], handler: OAuthHandler): RouteHandlers {
  const run = async (method: HttpMethod, req: Request): Promise<Response> => {
    const started = Date.now();
    const finish = (res: Response, fields: LogFields & Pick<Outcome, 'outcome'> & { missing?: string[] }): Response => {
      logOutcome({ route, status: res.status, ms: Date.now() - started, ...fields });
      return res;
    };

    const cfg = oauthConfig();
    if (cfg.state === 'off') return oauthError(404, 'not_found');
    if (cfg.state === 'misconfigured') {
      return finish(oauthError(503, 'temporarily_unavailable'), { outcome: 'misconfigured', missing: cfg.missing });
    }
    if (!allowed.includes(method)) return finish(methodNotAllowed(allowed), { outcome: 'method_not_allowed' });

    const fields: LogFields = {};
    try {
      const res = await handler(req, cfg, fields);
      return finish(method === 'HEAD' ? withoutBody(res) : res, { outcome: 'ok', ...fields });
    } catch (err) {
      const name = errorNameTag(err);
      try {
        Sentry.captureMessage(ROUTE_ERROR_MESSAGE, { level: 'error', tags: { route, error_name: name } });
      } catch {
        // reporting must never change the response
      }
      return finish(oauthError(503, 'temporarily_unavailable'), { outcome: 'error', error: name });
    }
  };

  const handlers = {} as RouteHandlers;
  for (const m of ALL_METHODS) handlers[m] = (req: Request) => run(m, req);
  return handlers;
}
