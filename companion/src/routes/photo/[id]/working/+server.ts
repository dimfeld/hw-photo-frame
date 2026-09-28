import { error } from '@sveltejs/kit';
import { library } from '$lib/server/store';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ params }) => {
  const bytes = await library.working(params.id);
  if (!bytes) error(404, 'Photo not found');
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' } });
};
