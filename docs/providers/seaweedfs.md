# SeaweedFS S3 Setup

[SeaweedFS](https://github.com/seaweedfs/seaweedfs) is an independent, high-performance distributed file system with native S3 API compatibility.

## Configuration

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
    path: build/
```

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


