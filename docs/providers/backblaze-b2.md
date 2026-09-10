# Backblaze B2 Setup

Backblaze B2 offers affordable S3-compatible cloud storage.

## Configuration

1. In the Backblaze B2 console, create a bucket and note its S3 endpoint (e.g. `s3.us-west-004.backblazeb2.com`).
2. Navigate to **App Keys** and create an **Application Key** with `readWrite` access to the bucket.
3. Use the `keyID` as `access-key` and `applicationKey` as `secret-key`.

```yaml
- name: Cache dependencies using Backblaze B2
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-b2-cache-bucket
    endpoint: https://s3.us-west-004.backblazeb2.com
    access-key: ${{ secrets.B2_KEY_ID }}
    secret-key: ${{ secrets.B2_APPLICATION_KEY }}
    key: ${{ runner.os }}-maven-${{ hashFiles('**/pom.xml') }}
    path: ~/.m2/repository
```

> [!TIP]
> Cloud Cache Action automatically parses the region (e.g. `us-west-004`) from the Backblaze endpoint URL, so you don't need to specify `region` manually.
