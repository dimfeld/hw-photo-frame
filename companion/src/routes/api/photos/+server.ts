import { error, json } from '@sveltejs/kit';
import { library } from '$lib/server/store';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request, url }) => {
  const name = url.searchParams.get('name');
  if (!name?.trim()) error(400, 'A file name is required.');
  const original = Buffer.from(await request.arrayBuffer());
  if (!original.length) error(400, 'The file is empty.');
  try { return json(await library.add(name, original), { status: 201 }); }
  catch (cause) {
    console.error('Photo upload failed', cause);
    error(422, 'Could not store this photo. Use a valid JPEG, PNG, WebP, or TIFF image. Check server logs if it still fails.');
  }
};
