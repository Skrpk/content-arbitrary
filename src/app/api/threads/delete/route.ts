import { getEnv } from '@/lib/env';
import { deletionConfirmationCode, deletionConfirmedAt } from '@/lib/threads/deletion';
import { forgetFromMetaCallback } from '@/lib/threads/meta-callback';

/**
 * Meta's data deletion callback, and the status page it points people to.
 *
 * POST — someone asked Meta for their data to be deleted from Zmistik. Their
 * Threads account is forgotten on every channel there and then, and Meta is
 * answered with where to see that and a confirmation code.
 *
 * GET ?code=… — that status, for a person to read.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const result = await forgetFromMetaCallback(request, 'deletion_requested');
  if (!result.ok) return result.response;
  const code = deletionConfirmationCode(result.appSecret);
  return Response.json(
    { url: `${result.webAppUrl}/api/threads/delete?code=${code}`, confirmation_code: code },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const env = getEnv();
  const code = new URL(request.url).searchParams.get('code');
  const at = env.THREADS_APP_SECRET ? deletionConfirmedAt(code, env.THREADS_APP_SECRET) : null;
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
  if (!at) {
    return new Response('Zmistik — data deletion\n\nThis confirmation code is not one we issued.\n', { status: 404, headers });
  }
  return new Response(
    `Zmistik — data deletion\n\nConfirmation code: ${code}\nStatus: completed on ${at.toISOString().slice(0, 10)}.\n\n` +
      'Your Threads account was disconnected from every Zmistik channel and its access token deleted. ' +
      'Posts already published to your Threads account stay there; you can delete them in Threads.\n',
    { headers },
  );
}
