import { library } from '$lib/server/store';
export const load = () => ({ photos: library.list(), settings: library.settings() });
