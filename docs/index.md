---
layout: home

hero:
  name: 'Cloud Cache Action'
  text: 'Cache to any S3 storage with 1:1 actions/cache parity'
  tagline: 'Drop-in replacement for actions/cache supporting AWS S3, Cloudflare R2, GCS, Backblaze B2, Fastly, Garage, SeaweedFS, MinIO, and RustFS.'
  image:
    src: /logo.svg
    alt: Cloud Cache Action
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Storage Providers
      link: /providers/aws-s3

features:
  - title: 1:1 actions/cache Parity
    details: Supports all inputs, outputs, restore-keys, and behaviors from actions/cache v4, v5, and v6 on modern Node 24 runners.
  - title: Universal S3 Compatibility
    details: First-class support for AWS S3, Cloudflare R2, Google Cloud Storage HMAC, Backblaze B2, Fastly, Garage, SeaweedFS, MinIO, and RustFS.
  - title: Custom S3 Key Templating
    details: Full control over object key structure via patterns like `${GITHUB_REPOSITORY}/${prefix}${key}/${archive_filename}` or custom overrides.
  - title: Standalone Sub-Actions
    details: Includes dedicated /restore and /save sub-actions for decoupled workflow architectures.
  - title: Fast & Resilient
    details: Multi-threaded zstd compression (with gzip fallback), streaming multipart uploads, and automatic exponential backoff retries.
  - title: MIT Licensed
    details: Created by Yurii Serhiichuk (<a href="https://serhiichuk.dev" target="_blank">serhiichuk.dev</a>). Free and open source.
---
