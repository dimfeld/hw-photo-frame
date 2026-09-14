import { library } from '$lib/server/store';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ url }) => {
  const settings = library.settings();
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Display-Seconds': String(settings.seconds ?? 0) };
  const next = library.next(url.searchParams.get('after'), url.searchParams.get('direction'));
  if (!next) return new Response(null, { status: 204, headers });
  const bytes = library.image(next.id, settings.fit, false)!;
  return new Response(new Uint8Array(bytes), { headers: { ...headers,
    'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
    'X-Frame-Format': 'rgb565le-1024x600', 'X-Photo-Id': next.id } });
};
