# Cloudflare R2 Setup

Cloudflare R2 provides zero egress fees, making it one of the most cost-effective caching backends for GitHub Actions.

## Configuration

1. Create a bucket in the Cloudflare dashboard under **R2 Object Storage**.
2. Generate an **R2 API Token** with `Object Read & Write` permissions.
3. Note your Cloudflare **Account ID** and API Token credentials (**Access Key ID** and **Secret Access Key**).

```yaml
- name: Cache dependencies using Cloudflare R2
  uses: xSAVIKx/cloud-cache-action@v0
  with:
    bucket: my-r2-cache-bucket
    endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
    access-key: ${{ secrets.R2_ACCESS_KEY_ID }}
    secret-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
    path: ~/.npm
```

> [!TIP]
> Cloud Cache Action automatically detects Cloudflare R2 from the endpoint URL and sets `region: auto` and `force-path-style: false` automatically.
