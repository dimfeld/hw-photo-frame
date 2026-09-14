import { error } from '@sveltejs/kit';
import { library } from '$lib/server/store';
import type { RequestHandler } from './$types';
export const DELETE: RequestHandler = ({ params }) => {
  if (!library.remove(params.id)) error(404, 'Photo not found');
  return new Response(null, { status: 204 });
};
