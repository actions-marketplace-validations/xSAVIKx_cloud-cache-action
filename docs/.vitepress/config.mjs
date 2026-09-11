import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Cloud Cache Action',
  description:
    'Fast, flexible GitHub Action caching to any S3-compatible storage with 1:1 actions/cache parity',
  base: '/cloud-cache-action/',
  sitemap: {
    hostname: 'https://xsavikx.github.io/cloud-cache-action/',
  },
  lastUpdated: true,
  transformHtml(code) {
    return code.replace('class="VPContent is-home"', 'role="main" class="VPContent is-home"');
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/cloud-cache-action/favicon.svg' }],
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/cloud-cache-action/favicon.ico' }],
    [
      'link',
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/cloud-cache-action/favicon-32x32.png',
      },
    ],
    [
      'link',
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '16x16',
        href: '/cloud-cache-action/favicon-16x16.png',
      },
    ],
    [
      'link',
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/cloud-cache-action/apple-touch-icon.png',
      },
    ],
    ['link', { rel: 'manifest', href: '/cloud-cache-action/site.webmanifest' }],
    ['meta', { name: 'theme-color', content: '#0ea5e9' }],
    ['meta', { property: 'og:image', content: '/cloud-cache-action/android-chrome-512x512.png' }],
    [
      'meta',
      { name: 'google-site-verification', content: 'sMLPKoYMB5EoPQiOfUJ51P7xLG55OXBKV9PTEvp2HPw' },
    ],
    ['link', { rel: 'describedby', href: 'https://xsavikx.github.io/cloud-cache-action/llms.txt' }],
  ],
  themeConfig: {
    logo: { src: '/logo.svg', alt: 'Cloud Cache Action' },
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Dual Caching', link: '/guide/dual-caching' },
      { text: 'Providers', link: '/providers/aws-s3' },
      { text: 'Key Patterns', link: '/guide/s3-key-patterns' },
      { text: 'Migration', link: '/guide/migration' },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/guide/getting-started' },
          { text: 'Dual Caching (S3 + GitHub)', link: '/guide/dual-caching' },
          { text: 'S3 Key Templating', link: '/guide/s3-key-patterns' },
          { text: 'Migrating from actions/cache', link: '/guide/migration' },
        ],
      },
      {
        text: 'Storage Providers',
        items: [
          { text: 'AWS S3', link: '/providers/aws-s3' },
          { text: 'Cloudflare R2', link: '/providers/cloudflare-r2' },
          { text: 'Google Cloud Storage (GCS)', link: '/providers/google-cloud-storage' },
          { text: 'Backblaze B2', link: '/providers/backblaze-b2' },
          { text: 'Fastly Object Storage', link: '/providers/fastly-storage' },
          { text: 'Garage S3', link: '/providers/garage' },
          { text: 'SeaweedFS S3', link: '/providers/seaweedfs' },
          { text: 'MinIO S3', link: '/providers/minio' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/xSAVIKx/cloud-cache-action' }],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Created by <a href="https://serhiichuk.dev" target="_blank">Yurii Serhiichuk</a>',
    },
  },
});
