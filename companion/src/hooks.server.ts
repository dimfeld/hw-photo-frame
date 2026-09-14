import { error, type Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { timingSafeEqual } from 'node:crypto';
export const handle: Handle = async ({ event, resolve }) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method)
      && event.request.headers.get('origin') !== event.url.origin) {
    error(403, 'Open the app at its configured address before you make changes.');
  }
  if (event.url.pathname.startsWith('/frame/') && env.FRAME_TOKEN) {
    const expected = Buffer.from(`Bearer ${env.FRAME_TOKEN}`);
    const actual = Buffer.from(event.request.headers.get('authorization') || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) error(401, 'Frame token required');
  }
  return resolve(event);
};
