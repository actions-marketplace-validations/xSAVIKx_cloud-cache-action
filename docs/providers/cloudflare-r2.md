# Cloudflare R2 Setup

[Cloudflare R2](https://www.cloudflare.com/developer-platform/r2/) provides S3-compatible object storage with **zero egress fees**, making it one of the most cost-effective and highest-throughput caching backends for GitHub Actions workflows.

---

## Best Practices: Bucket Setup & Configuration

Follow these guidelines when setting up your Cloudflare R2 cache bucket:

### 1. Bucket Creation & Location Hint
1. In the Cloudflare dashboard, navigate to **R2 Object Storage** > **Create bucket**.
2. **Bucket Name**: Use a descriptive name such as `my-org-ci-cache`.
3. **Location Hint**: Choose a region hint close to your GitHub Actions runners:
   - `wnam` (Western North America) or `enam` (Eastern North America) for default GitHub-hosted runners.
   - `weur` or `eeur` for European runners.
   - `apac` for Asia-Pacific runners.
   - Or leave as **Automatic** for dynamic edge placement.

### 2. Security & Public Access
- **Keep Public Access Disabled**: Do not enable the public R2 `r2.dev` test domain or attach a custom domain. Cache archives contain build artifacts and private dependencies and must remain completely private.
- **Data Encryption**: All data stored in Cloudflare R2 is automatically encrypted at rest using strong AES-256 ciphers with zero manual configuration needed.

### 3. Lifecycle Expiration Rules
To prevent outdated cache archives from accumulating indefinitely:
1. In your bucket page, click **Settings** > **Lifecycle Rules** > **Add rule**.
2. Set a rule name (e.g., `expire-old-caches`).
3. Set **Action** to **Delete objects**.
4. Set **Age** to **30 days** (or 60 days for low-frequency branches).
5. Add an **Abort incomplete multipart uploads** rule after **7 days**.

---

## Credentials & API Token Setup

Never use account-wide administrative tokens for CI workflows. Create a scoped, bucket-specific API token:

### 1. Create a Scoped R2 API Token
1. In the Cloudflare dashboard, navigate to **R2** > **Manage R2 API Tokens** > **Create API token**.
2. **Token Name**: `github-actions-cache`.
3. **Permissions**: Select **Object Read & Write**.
4. **Bucket Scope**: Select **Apply to specific buckets only**, and choose your cache bucket.
5. (Optional) Set a **TTL / Expiration date** to satisfy organizational security rotation policies.
6. Click **Create API Token**.

### 2. Configure GitHub Secrets
Cloudflare will display the credentials **once**. Copy and store them in your repository's **Settings** > **Secrets and variables** > **Actions**:

| Secret Name | Source in Cloudflare |
| :--- | :--- |
| `R2_ACCOUNT_ID` | Found on the R2 overview page in the right sidebar |
| `R2_ACCESS_KEY_ID` | Displayed on the token creation screen |
| `R2_SECRET_ACCESS_KEY` | Displayed on the token creation screen |

---

## Workflow Configuration

```yaml
- name: Cache dependencies using Cloudflare R2
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-org-ci-cache
    endpoint: https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com
    access-key: ${{ secrets.R2_ACCESS_KEY_ID }}
    secret-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
    path: ~/.npm
```

> [!TIP]
> **Automatic Provider Detection**: Cloud Cache Action automatically recognizes `*.r2.cloudflarestorage.com` endpoints and configures `region: auto` and `force-path-style: false` automatically.

---

## Live CI Verification Workflow

This action is tested continuously against Cloudflare R2 with zero egress fees. You can inspect the live GitHub Actions workflow file in the repository: [`.github/workflows/provider-r2.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/provider-r2.yml).

::: details `.github/workflows/provider-r2.yml` (Click to view full workflow)
<<< ../../.github/workflows/provider-r2.yml{yaml}
:::

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Expiry**: the action never deletes caches. Add a lifecycle rule that expires objects after 30–60 days so old caches do not accumulate.
