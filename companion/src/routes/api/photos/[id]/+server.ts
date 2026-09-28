import { error, json } from '@sveltejs/kit';
import { library } from '$lib/server/store';
import type { RequestHandler } from './$types';
export const PUT: RequestHandler = async ({ params, request }) => {
  let layout;
  try { layout = await library.saveLayout(params.id, await request.json()); }
  catch { error(400, 'Enter a valid photo layout.'); }
  if (!layout) error(404, 'Photo not found');
  return json(layout);
};
export const DELETE: RequestHandler = ({ params }) => {
  if (!library.remove(params.id)) error(404, 'Photo not found');
  return new Response(null, { status: 204 });
};
