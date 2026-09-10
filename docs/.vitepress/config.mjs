import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Cloud Cache Action',
  description: 'Fast, flexible GitHub Action caching to any S3-compatible storage with 1:1 actions/cache parity',
  base: '/cloud-cache-action/',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Providers', link: '/providers/aws-s3' },
      { text: 'Key Patterns', link: '/guide/s3-key-patterns' },
      { text: 'Migration', link: '/guide/migration' },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/guide/getting-started' },
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
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/xSAVIKx/cloud-cache-action' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Created by <a href="https://serhiichuk.dev" target="_blank">Yurii Serhiichuk</a>',
    },
  },
});
