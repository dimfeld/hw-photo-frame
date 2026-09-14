import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { env } from '$env/dynamic/private';
import { Library } from './library';
const directory = resolve(env.PHOTO_DATA_DIR || './data');
mkdirSync(directory, { recursive: true });
export const library = new Library(join(directory, 'photos.sqlite'));
