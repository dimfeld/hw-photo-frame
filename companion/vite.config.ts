import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [sveltekit()], ssr: { external: ['bun:sqlite', 'sharp'] } });
