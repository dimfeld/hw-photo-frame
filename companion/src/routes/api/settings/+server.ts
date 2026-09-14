import { error, json } from '@sveltejs/kit';
import { library } from '$lib/server/store';
import type { RequestHandler } from './$types';
export const PUT: RequestHandler = async ({ request }) => {
  try { return json(library.saveSettings(await request.json())); }
  catch { error(400, 'Enter a positive whole number of seconds and valid display options.'); }
};
