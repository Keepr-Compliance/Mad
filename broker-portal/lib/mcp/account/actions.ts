'use server';

/**
 * Server actions of the consent page and the AI apps page (BACKLOG-4238).
 *
 * Each action checks, in order and before any database call: MCP is on, no
 * support-session cookie, the exact arguments. The consent actions then need
 * exactly one binding cookie and a complete OAuth configuration. The consent
 * actions return the address to go back to; the browser navigates.
 */

import { revalidatePath } from 'next/cache';
import { mcpEnabled } from '@/lib/mcp/config';
import { oauthConfig } from '@/lib/mcp/oauth/config';
import { bindingDigest, digest, newToken } from '@/lib/mcp/oauth/crypto';
import { clientRedirect } from '@/lib/mcp/oauth/redirect';
import { isConnectionId, isNonce, isRequestId } from '@/lib/mcp/oauth/validate';
import { M_A, M_C } from './messages';
import { logAccount } from './logging';
import { readAccountRequest } from './request';
import { approveRequest, denyRequest, disconnectAllMine, disconnectConnection } from './rpc';

const AI_APPS_PATH = '/dashboard/account/ai-apps';

export type ConsentActionResult = { kind: 'redirect'; location: string } | { kind: 'refused'; message: string };
type DisconnectActionResult = { ok: true } | { ok: false; message: string };

const log = logAccount;

function refused(message: string): ConsentActionResult {
  return { kind: 'refused', message };
}

const APPROVE_MESSAGES: Record<string, string> = {
  request_invalid: M_C.requestInvalid,
  not_signed_in: M_C.sessionEnded,
  impersonating: M_C.supportSession,
  disabled: M_C.disabled,
  not_entitled: M_C.notEntitled,
  invalid_request: M_C.failed,
};

type Decision = 'approve' | 'deny';

async function decide(which: Decision, argc: number, requestId: unknown, nonce: unknown): Promise<ConsentActionResult> {
  const started = Date.now();
  if (!mcpEnabled()) {
    log('consent', `${which}_off`, 404, started);
    return refused(M_C.disabled);
  }
  const req = await readAccountRequest();
  if (req.impersonating) {
    log('consent', `${which}_support_session`, 403, started);
    return refused(M_C.supportSession);
  }
  if (argc !== 2 || !isRequestId(requestId) || !isNonce(nonce)) {
    log('consent', `${which}_bad_arguments`, 400, started);
    return refused(M_C.failed);
  }
  if (req.binding === null) {
    log('consent', `${which}_no_binding`, 400, started);
    return refused(M_C.noBinding);
  }
  const cfg = oauthConfig();
  if (cfg.state !== 'ok') {
    log('consent', `${which}_misconfigured`, 503, started);
    return refused(M_C.misconfigured);
  }

  const code = which === 'approve' ? newToken('ac') : null;
  const result =
    code !== null
      ? await approveRequest(requestId, bindingDigest(req.binding), nonce, digest(cfg.pepper, code))
      : await denyRequest(requestId, bindingDigest(req.binding), nonce);

  if (result.kind === 'transport') {
    log('consent', `${which}_transport`, 503, started, result);
    return refused(M_C.failed);
  }
  if (result.kind === 'refused') {
    log('consent', `${which}_${result.error}`, 200, started);
    return refused(APPROVE_MESSAGES[result.error] ?? M_C.failed);
  }

  const params: Array<[string, string | null]> =
    code !== null
      ? [
          ['code', code],
          ['state', result.state],
        ]
      : [
          ['error', 'access_denied'],
          ['state', result.state],
        ];
  const location = clientRedirect(result.redirectUri, params, cfg.issuer);
  if (location === null) {
    log('consent', `${which}_redirect_refused`, 503, started);
    return refused(M_C.noReturn);
  }
  log('consent', which === 'approve' ? 'approved' : 'denied', 200, started);
  return { kind: 'redirect', location };
}

/** Allow on the consent page. Arguments: the request id and the nonce of this render. */
export async function approveAiApp(...args: unknown[]): Promise<ConsentActionResult> {
  return decide('approve', args.length, args[0], args[1]);
}

/** Deny on the consent page. Arguments: the request id and the nonce of this render. */
export async function denyAiApp(...args: unknown[]): Promise<ConsentActionResult> {
  return decide('deny', args.length, args[0], args[1]);
}

function disconnectRefused(message: string): DisconnectActionResult {
  return { ok: false, message };
}

/** Disconnect one AI app on the AI apps page. */
export async function disconnectAiApp(...args: unknown[]): Promise<DisconnectActionResult> {
  const started = Date.now();
  const argc = args.length;
  const connectionId = args[0];
  if (!mcpEnabled()) {
    log('ai-apps', 'disconnect_off', 404, started);
    return disconnectRefused(M_C.disabled);
  }
  const req = await readAccountRequest();
  if (req.impersonating) {
    log('ai-apps', 'disconnect_support_session', 403, started);
    return disconnectRefused(M_A.supportSession);
  }
  if (argc !== 1 || !isConnectionId(connectionId)) {
    log('ai-apps', 'disconnect_bad_arguments', 400, started);
    return disconnectRefused(M_A.disconnectFailed);
  }
  const result = await disconnectConnection(connectionId);
  if (result.kind !== 'ok') {
    if (result.kind === 'refused') log('ai-apps', `disconnect_${result.error}`, 503, started);
    else log('ai-apps', 'disconnect_transport', 503, started, result);
    return disconnectRefused(
      result.kind === 'refused' && result.error === 'impersonating' ? M_A.supportSession : M_A.disconnectFailed
    );
  }
  revalidatePath(AI_APPS_PATH);
  log('ai-apps', 'disconnected', 200, started);
  return { ok: true };
}

/** "Disconnect all AI apps" on the AI apps page. */
export async function disconnectAllAiApps(...args: unknown[]): Promise<DisconnectActionResult> {
  const started = Date.now();
  const argc = args.length;
  if (!mcpEnabled()) {
    log('ai-apps', 'disconnect_all_off', 404, started);
    return disconnectRefused(M_C.disabled);
  }
  const req = await readAccountRequest();
  if (req.impersonating) {
    log('ai-apps', 'disconnect_all_support_session', 403, started);
    return disconnectRefused(M_A.supportSession);
  }
  if (argc !== 0) {
    log('ai-apps', 'disconnect_all_bad_arguments', 400, started);
    return disconnectRefused(M_A.disconnectFailed);
  }
  const result = await disconnectAllMine();
  if (result.kind !== 'ok') {
    if (result.kind === 'refused') log('ai-apps', `disconnect_all_${result.error}`, 503, started);
    else log('ai-apps', 'disconnect_all_transport', 503, started, result);
    return disconnectRefused(
      result.kind === 'refused' && result.error === 'impersonating' ? M_A.supportSession : M_A.disconnectFailed
    );
  }
  revalidatePath(AI_APPS_PATH);
  log('ai-apps', 'disconnected_all', 200, started);
  return { ok: true };
}
