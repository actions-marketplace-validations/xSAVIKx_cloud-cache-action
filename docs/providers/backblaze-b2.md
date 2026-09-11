# Backblaze B2 Setup

[Backblaze B2](https://www.backblaze.com/cloud-storage) offers highly affordable, S3-compatible cloud object storage with low storage costs and predictable pricing.

---

## Best Practices: Bucket Setup & Configuration

Follow these recommendations when setting up your Backblaze B2 cache bucket:

### 1. Bucket Creation & Access
1. In the Backblaze B2 console, navigate to **Buckets** > **Create a Bucket**.
2. **Bucket Unique Name**: Enter a globally unique name (e.g., `my-org-ci-cache`).
3. **Files in Bucket are**: Select **Private** (never choose Public).
4. **Default Encryption**: Enable **Enabled** (Server-Side Encryption / SSE-B2) to secure all cache bundles at rest.
5. **Object Lock**: Select **Disabled**. Object Lock prevents deletion during retention windows and will cause cache lifecycle expiration to fail.

### 2. Lifecycle Rules & Automatic Deletion
By default, Backblaze B2 keeps all uploaded versions of files forever. To avoid runaway storage bills:
1. In your bucket list, click **Lifecycle Settings**.
2. Choose **Custom Lifecycle Settings**.
3. Add a rule:
   - **File Name Prefix**: Leave blank (applies to all archives in bucket).
   - **Days until hiding**: `30` days (hides older cache files).
   - **Days until deleting**: `1` day (permanently deletes hidden files).

---

## Credentials & Scoped Application Keys

Never use your master Backblaze application key for CI workflows. Always generate a bucket-restricted application key:

### 1. Create a Restricted Application Key
1. In the Backblaze B2 console, navigate to **Account** > **Application Keys**.
2. Click **Add a New Application Key**.
3. **Name of Key**: `github-actions-cache`.
4. **Allow access to Bucket(s)**: Select your dedicated CI cache bucket (do **not** select "All").
5. **Type of Access**: Select **Read and Write**.
6. Click **Create New Key**.

### 2. Configure GitHub Secrets
Backblaze will display your `applicationKey` **only once**:

| Secret Name | Value in Backblaze |
| :--- | :--- |
| `B2_KEY_ID` | The `keyID` string (25-character alphanumeric ID) |
| `B2_APPLICATION_KEY` | The `applicationKey` secret string (31-character token) |

---

## Workflow Configuration

```yaml
- name: Cache dependencies using Backblaze B2
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-b2-cache-bucket
    endpoint: https://s3.us-west-004.backblazeb2.com # Replace with your bucket's S3 endpoint
    access-key: ${{ secrets.B2_KEY_ID }}
    secret-key: ${{ secrets.B2_APPLICATION_KEY }}
    key: ${{ runner.os }}-maven-${{ hashFiles('**/pom.xml') }}
    restore-keys: |
      ${{ runner.os }}-maven-
    path: ~/.m2/repository
```

> [!TIP]
> **Automatic Region Detection**: Cloud Cache Action automatically parses the AWS-compatible region (e.g. `us-west-004` or `eu-central-003`) directly from your Backblaze endpoint URL, so you do not need to specify `region` manually.
