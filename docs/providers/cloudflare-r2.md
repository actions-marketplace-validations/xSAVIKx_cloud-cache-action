# Cloudflare R2 Setup

Cloudflare R2 provides zero egress fees, making it one of the most cost-effective caching backends for GitHub Actions.

## Configuration

1. Create a bucket in the Cloudflare dashboard under **R2 Object Storage**.
2. Generate an **R2 API Token** with `Object Read & Write` permissions.
3. Note your Cloudflare **Account ID** and API Token credentials (**Access Key ID** and **Secret Access Key**).

```yaml
- name: Cache dependencies using Cloudflare R2
  uses: xSAVIKx/cloud-cache-action@v1
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

## Live CI Verification Workflow

This action is tested continuously against Cloudflare R2 with zero egress fees. You can inspect the live GitHub Actions workflow file in the repository: [`.github/workflows/provider-r2.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/provider-r2.yml).

::: details `.github/workflows/provider-r2.yml` (Click to view full workflow)
<<< ../../.github/workflows/provider-r2.yml{yaml}
:::

