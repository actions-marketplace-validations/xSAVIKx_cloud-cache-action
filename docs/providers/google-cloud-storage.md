# Google Cloud Storage (GCS) Setup

Google Cloud Storage provides full S3 interoperability via its XML API and HMAC service account keys.

## Configuration

1. In the Google Cloud Console, navigate to **Cloud Storage** > **Settings** > **Interoperability**.
2. Create an **HMAC Key** for your service account or user. You will receive an **Access ID** and **Secret**.
3. Use `https://storage.googleapis.com` as the endpoint.

```yaml
- name: Cache dependencies using Google Cloud Storage
  uses: xSAVIKx/cloud-cache-action@v0
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
