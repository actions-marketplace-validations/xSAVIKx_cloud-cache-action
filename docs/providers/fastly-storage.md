# Fastly Object Storage Setup

[Fastly Object Storage](https://www.fastly.com/products/object-storage) provides high-performance, S3-compatible cloud storage colocated with Fastly's global edge network, delivering low latency and high bandwidth for CI/CD runners.

---

## Best Practices: Bucket Setup & Configuration

Follow these recommendations when setting up your Fastly Object Storage bucket:

### 1. Bucket Region & Placement
- In the Fastly Control Panel, navigate to **Storage** > **Object Storage** > **Create bucket**.
- **Region Selection**: Select the region closest to where your GitHub Actions runners run (e.g., US-East or EU-Central) to minimize transit hops and accelerate cache restores.
- **Access Level**: Ensure the bucket is private. Public read permissions should remain disabled.

### 2. Lifecycle Rules & Automatic Eviction
CI cache bundles should have an expiration policy so stale dependencies are naturally evicted:
- Set up an automated lifecycle rule in the bucket management console to expire and delete objects older than **30** or **60 days**.
- Ensure incomplete multipart uploads are configured to abort after **7 days**.

---

## Credentials & Access Management

### 1. Generate S3-Compatible Credentials
1. In Fastly Object Storage, navigate to **Access Keys** / **API Credentials**.
2. Create a new key pair scoped specifically to your CI cache bucket with **Read/Write** permissions.
3. Note the generated **Access Key** and **Secret Key**.

### 2. Configure GitHub Secrets
Store the credentials in your repository's **Settings** > **Secrets and variables** > **Actions**:

| Secret Name | Description |
| :--- | :--- |
| `FASTLY_ACCESS_KEY` | Fastly S3 Access Key ID |
| `FASTLY_SECRET_KEY` | Fastly S3 Secret Access Key |

---

## Workflow Configuration

```yaml
- name: Cache dependencies using Fastly Object Storage
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-fastly-cache-bucket
    endpoint: https://object.us-east-1.fastlystorage.com # Replace with your region
    access-key: ${{ secrets.FASTLY_ACCESS_KEY }}
    secret-key: ${{ secrets.FASTLY_SECRET_KEY }}
    key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}
    restore-keys: |
      ${{ runner.os }}-cargo-
    path: |
      ~/.cargo/bin/
      ~/.cargo/registry/index/
      ~/.cargo/registry/cache/
      target/
```

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
