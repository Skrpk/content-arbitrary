import { forgetFromMetaCallback } from '@/lib/threads/meta-callback';

/**
 * POST /api/threads/deauthorize — Meta's uninstall callback: someone removed
 * Zmistik from their Threads account. Their account is disconnected from
 * every channel, and its token deleted.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const result = await forgetFromMetaCallback(request, 'deauthorized');
  if (!result.ok) return result.response;
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
