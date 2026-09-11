# MinIO S3 Setup

[MinIO](https://min.io/) is an open-source, high-performance distributed object store with native S3 API compatibility, widely used for on-premise deployments and local CI testing.

## Configuration

When using MinIO with `cloud-cache-action`:

```yaml
- name: Cache dependencies using MinIO
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: http://minio.internal:9000
    access-key: ${{ secrets.MINIO_ACCESS_KEY }}
    secret-key: ${{ secrets.MINIO_SECRET_KEY }}
    force-path-style: true
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

> [!TIP]
> Always enable `force-path-style: true` for MinIO unless you have configured custom DNS subdomains for your buckets.

## Running MinIO Locally for Integration Testing

You can spin up MinIO locally using the repository's [`docker-compose.test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/docker-compose.test.yml):

```bash
docker compose -f docker-compose.test.yml up -d minio
```

::: details `docker-compose.test.yml` (Click to view Compose definition)
<<< ../../docker-compose.test.yml{yaml}
:::

Once running:
- **S3 API**: `http://localhost:9000`
- **Web Console**: `http://localhost:9001` (Default credentials: `minioadmin` / `minioadmin`)
