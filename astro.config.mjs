// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://krishtheduck.github.io',
  integrations: [tailwind()],
});