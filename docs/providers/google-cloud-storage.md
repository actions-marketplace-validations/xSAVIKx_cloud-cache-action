# Google Cloud Storage (GCS) Setup

Google Cloud Storage (GCS) provides full S3 interoperability via its XML API and HMAC service account keys, allowing you to use GCS as a high-speed caching tier for your GitHub Actions workflows.

---

## Best Practices: Bucket Setup & Configuration

Follow these recommendations when creating your GCS cache bucket:

### 1. Bucket Location & Storage Class
- **Location Type**: Choose a **Region** bucket (e.g., `us-central1` or `europe-west1`) colocated with your runners. Avoid multi-region or dual-region buckets unless required for multi-continent runners, as regional buckets offer lower latency and avoid inter-region network charges.
- **Storage Class**: Always select **Standard**. Never use *Nearline*, *Coldline*, or *Archive* storage classes for CI caches. These colder tiers charge data retrieval fees every time a cache is restored and enforce minimum storage retention periods (30 to 90 days), resulting in higher costs for frequently updated caches.

### 2. Access Control & Security
- **Public Access Prevention**: Enable **Enforce public access prevention** on the bucket to ensure archives are never exposed publicly.
- **Access Control Model**: Select **Uniform** bucket-level access (Google's recommended best practice), which uses Cloud IAM policies exclusively rather than legacy object-level ACLs.
- **Data Protection**: Keep Soft Delete enabled or configure a 7-day retention period if you want protection against accidental deletion.

### 3. Object Lifecycle Management
Configure an automated lifecycle policy in the Google Cloud Console (**Bucket** > **Lifecycle** > **Add a rule**):

1. **Delete Expired Archives**:
   - **Action**: Delete object.
   - **Condition**: Age is **30 days** (or 60 days).
2. **Abort Incomplete Multipart Uploads**:
   - **Action**: Abort incomplete multipart uploads after **7 days**.

---

## Credentials & Interoperability Setup

GCS supports S3 API requests using HMAC (Hash-based Message Authentication Code) credentials. 

> [!IMPORTANT]
> Always create HMAC keys for a **dedicated Service Account**, never for personal user Google accounts. User HMAC keys are tied to individual accounts and break when employees change roles or leave an organization.

### 1. Create a Dedicated Service Account
1. In the Google Cloud Console, navigate to **IAM & Admin** > **Service Accounts** > **Create Service Account**.
2. **Name**: `github-actions-ci-cache`.
3. Click **Create and Continue**.

### 2. Grant Least-Privilege Bucket Permissions
Do not grant project-wide Editor or Storage Admin roles. Grant access strictly on your cache bucket:
1. Navigate to **Cloud Storage** > **Buckets** > Click your cache bucket.
2. Under the **Permissions** tab, click **Grant Access**.
3. **New principals**: Enter the email of your dedicated service account (`github-actions-ci-cache@<project-id>.iam.gserviceaccount.com`).
4. **Role**: Select **Storage Object User** (`roles/storage.objectUser`), which allows reading, writing, and listing objects without bucket administrative privileges.

### 3. Generate HMAC Key for the Service Account
1. In the Google Cloud Console, navigate to **Cloud Storage** > **Settings** > **Interoperability**.
2. Under **Interoperability keys for service accounts**, click **Create a key for a service account**.
3. Select your `github-actions-ci-cache` service account.
4. Copy the generated **Access ID** (acts as the access key) and **Secret** (acts as the secret key).

### 4. Configure GitHub Secrets
Store the credentials in your repository's **Settings** > **Secrets and variables** > **Actions**:

| Secret Name | Description |
| :--- | :--- |
| `GCS_HMAC_ACCESS_ID` | The generated HMAC Access ID (starts with `GOOG...`) |
| `GCS_HMAC_SECRET` | The generated HMAC Secret key |

---

## Workflow Configuration

```yaml
- name: Cache dependencies using Google Cloud Storage
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-gcs-cache-bucket
    endpoint: https://storage.googleapis.com
    access-key: ${{ secrets.GCS_HMAC_ACCESS_ID }}
    secret-key: ${{ secrets.GCS_HMAC_SECRET }}
    key: ${{ runner.os }}-gradle-${{ hashFiles('**/*.gradle*') }}
    restore-keys: |
      ${{ runner.os }}-gradle-
    path: ~/.gradle/caches
```

> [!NOTE]
> **Path-Style Addressing**: Google Cloud Storage XML API requires path-style addressing (`force-path-style: true`). Cloud Cache Action automatically detects `storage.googleapis.com` and sets path-style addressing and region defaults without extra configuration.

---

## Live CI Verification Workflow

This action is tested continuously against Google Cloud Storage using HMAC keys and the XML API. You can inspect the live GitHub Actions workflow file in the repository: [`.github/workflows/provider-gcs.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/provider-gcs.yml).

::: details `.github/workflows/provider-gcs.yml` (Click to view full workflow)
<<< ../../.github/workflows/provider-gcs.yml{yaml}
:::
