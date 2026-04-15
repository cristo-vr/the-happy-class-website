// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'static',
  site: 'https://thehappyclass.com',
  integrations: [sitemap()],
  build: {
    assets: '_assets',
  },
});
