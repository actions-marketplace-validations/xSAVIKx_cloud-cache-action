# Fastly Object Storage Setup

Fastly Object Storage provides edge-proximate S3-compatible storage.

## Configuration

1. In Fastly Object Storage, retrieve your bucket name, access credentials, and S3 endpoint (e.g. `https://object.<region>.fastlystorage.com`).
2. Add them to your workflow:

```yaml
- name: Cache dependencies using Fastly Object Storage
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-fastly-cache-bucket
    endpoint: https://object.us-east-1.fastlystorage.com
    access-key: ${{ secrets.FASTLY_ACCESS_KEY }}
    secret-key: ${{ secrets.FASTLY_SECRET_KEY }}
    key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}
    path: |
      ~/.cargo/bin/
      ~/.cargo/registry/index/
      ~/.cargo/registry/cache/
      target/
```
