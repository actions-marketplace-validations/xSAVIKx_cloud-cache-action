# SeaweedFS S3 Setup

[SeaweedFS](https://github.com/seaweedfs/seaweedfs) is an independent, high-performance distributed file system with native S3 API compatibility designed for handling billions of files with fast, constant-time lookups.

---

## Best Practices: Bucket & Cluster Setup

Follow these recommendations when setting up SeaweedFS for CI/CD caching:

### 1. Architecture & S3 Gateway
- **Single-Server / Dev Runner**: Run `weed server -s3 -s3.port=8333` for an all-in-one Master, Volume, Filer, and S3 API server.
- **Production Cluster**: Separate the Master, Filer, and Volume nodes. Run multiple stateless `weed s3` gateway instances behind a load balancer pointing to the shared Filer cluster.

### 2. Native Time-To-Live (TTL) & Auto-Pruning
SeaweedFS has built-in support for Time-To-Live (TTL) at the filer level, making it uniquely efficient for CI caches:
- You can configure default directory TTL so cache files are automatically garbage-collected at the volume chunk level after 30 days without needing manual cleanup jobs.
- Example filer configuration for automatic cache eviction:
  ```bash
  # Configure a 30-day TTL on the cache directory
  weed filer.meta.tail -timeAgo=30d
  ```

### 3. Volume Compaction & Vacuuming
As older caches expire and are deleted, SeaweedFS marks chunks as deleted. The master automatically vacuums volume servers when garbage exceeds the threshold (default 30%):
```bash
# Force volume vacuuming via the master admin API
curl "http://localhost:9333/vol/vacuum?garbageThreshold=0.2"
```

---

## Credentials & Authentication Setup (`s3.json`)

In production environments, configure authentication using SeaweedFS's `s3.json` configuration file:

### 1. Configure Identities in `s3.json`
Place an `s3.json` configuration file in your SeaweedFS configuration folder (e.g. `/etc/seaweedfs/s3.json`):

```json
{
  "identities": [
    {
      "name": "ci-runner",
      "credentials": [
        {
          "accessKey": "seaweed-ci-access-key",
          "secretKey": "seaweed-ci-super-secret-key"
        }
      ],
      "actions": [
        "Read",
        "Write",
        "List"
      ]
    }
  ]
}
```

### 2. Configure GitHub Secrets
Save your credentials in repository **Settings** > **Secrets and variables** > **Actions**:

| Secret Name | Description |
| :--- | :--- |
| `SEAWEED_ACCESS_KEY` | The `accessKey` configured in `s3.json` |
| `SEAWEED_SECRET_KEY` | The `secretKey` configured in `s3.json` |

---

## Workflow Configuration

```yaml
- name: Cache dependencies using SeaweedFS
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: http://seaweedfs.internal:8333 # S3 API endpoint
    provider: seaweedfs
    access-key: ${{ secrets.SEAWEED_ACCESS_KEY }}
    secret-key: ${{ secrets.SEAWEED_SECRET_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    restore-keys: |
      ${{ runner.os }}-build-
    path: build/
```

---

## Running SeaweedFS Locally for Testing

You can spin up SeaweedFS locally with S3 enabled using the repository's [`docker-compose.test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/docker-compose.test.yml):

```bash
docker compose -f docker-compose.test.yml up -d seaweedfs
```

::: details `docker-compose.test.yml` (Click to view Compose definition)
<<< ../../docker-compose.test.yml{yaml}
:::

Once running:
- **S3 API**: `http://localhost:8333`
- **Master UI**: `http://localhost:9333`
- Pre-configured with automatic bucket creation on first write.

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Expiry**: the action never deletes caches. Add a lifecycle rule that expires objects after 30–60 days so old caches do not accumulate.
