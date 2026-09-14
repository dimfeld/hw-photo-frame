import { error } from '@sveltejs/kit';
import { library } from '$lib/server/store';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ params, url }) => {
  const fit = url.searchParams.get('fit') === 'cover' ? 'cover' : 'contain';
  const bytes = library.image(params.id, fit, true);
  if (!bytes) error(404, 'Photo not found');
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-cache' } });
};
