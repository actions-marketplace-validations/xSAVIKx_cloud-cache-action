# Google Cloud Storage (GCS) Setup

Google Cloud Storage provides full S3 interoperability via its XML API and HMAC service account keys.

## Configuration

1. In the Google Cloud Console, navigate to **Cloud Storage** > **Settings** > **Interoperability**.
2. Create an **HMAC Key** for your service account or user. You will receive an **Access ID** and **Secret**.
3. Use `https://storage.googleapis.com` as the endpoint.

```yaml
- name: Cache dependencies using Google Cloud Storage
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-gcs-cache-bucket
    endpoint: https://storage.googleapis.com
    access-key: ${{ secrets.GCS_HMAC_ACCESS_ID }}
    secret-key: ${{ secrets.GCS_HMAC_SECRET }}
    key: ${{ runner.os }}-gradle-${{ hashFiles('**/*.gradle*') }}
    path: ~/.gradle/caches
```

> [!NOTE]
> GCS S3 interoperability requires path-style addressing (`force-path-style: true`). Cloud Cache Action auto-detects `storage.googleapis.com` and automatically configures path-style addressing and region defaults.

## Live CI Verification Workflow

This action is tested continuously against Google Cloud Storage using HMAC keys and the XML API. You can inspect the live GitHub Actions workflow file in the repository: [`.github/workflows/provider-gcs.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/provider-gcs.yml).

::: details `.github/workflows/provider-gcs.yml` (Click to view full workflow)
<<< ../../.github/workflows/provider-gcs.yml{yaml}
:::

