# Garage S3 Setup

[Garage](https://garagehq.deuxfleurs.fr/) is an open-source, lightweight distributed S3-compatible storage system designed to be self-hosted on commodity hardware, bare-metal servers, or home labs with minimal resource usage.

---

## Best Practices: Bucket & Cluster Setup

Follow these recommendations when configuring Garage for CI/CD caching:

### 1. Cluster Layout & Replication
- **Single-Node CI Runner Cache**: Set `replication_factor = 1` in `garage.toml` if running on a single build server or local runner node to maximize available storage capacity.
- **Multi-Node Cluster**: Use `replication_factor = 3` across multiple physical nodes or availability zones for high availability and zero-downtime runner caching.

### 2. Disk Space Protection & Bucket Quotas
Continuous integration workloads can quickly consume hundreds of gigabytes of storage if left unchecked. Garage provides built-in quota controls:
```bash
# Set a hard storage quota on the CI cache bucket (e.g. 50 GB)
garage bucket set --max-size 50G ci-cache

# Set a limit on the total number of cache objects (e.g. 10,000 objects)
garage bucket set --max-objects 10000 ci-cache
```

### 3. Periodic Garbage Collection
Run periodic garbage collection on your Garage cluster to prune stale blocks and reclaim disk space:
```bash
# Check block storage status and run GC
garage gc
```

### 4. Network Security
- The Garage S3 API port (`3900`) and Admin port (`3902`) should remain on internal networks, private VPCs, or encrypted VPN overlays (e.g. Tailscale / WireGuard).
- If exposing Garage across networks, place it behind an SSL/TLS reverse proxy (e.g. Traefik, Caddy, Nginx).

---

## Credentials & Key Management

Garage provides a clean CLI for managing credentials and granting least-privilege bucket access:

### 1. Create a Dedicated API Key
```bash
# Create an access key named 'ci-runner-key'
garage key create ci-runner-key
```
Garage will output the **Key ID** (`GK...`) and **Secret Key**.

### 2. Create the Cache Bucket & Authorize Key
```bash
# Create the bucket
garage bucket create ci-cache

# Grant read and write permissions to the key
garage bucket allow ci-cache --read --write --key ci-runner-key
```

### 3. Verify Key Permissions
```bash
# Inspect key details and bound buckets at any time
garage key info ci-runner-key
```

### 4. Configure GitHub Secrets
Save the credentials in your repository or organization secrets:

| Secret Name | Source |
| :--- | :--- |
| `GARAGE_ACCESS_KEY` | Output of `garage key info ci-runner-key` (Key ID) |
| `GARAGE_SECRET_KEY` | Output of `garage key info ci-runner-key` (Secret Key) |

---

## Workflow Configuration

```yaml
- name: Cache dependencies using self-hosted Garage
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: http://garage.internal:3900 # Replace with your Garage S3 endpoint
    provider: garage
    access-key: ${{ secrets.GARAGE_ACCESS_KEY }}
    secret-key: ${{ secrets.GARAGE_SECRET_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

---

## Running Garage Locally for Integration Testing

You can spin up Garage locally using the repository's [`docker-compose.test.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/docker-compose.test.yml):

```bash
docker compose -f docker-compose.test.yml up -d garage
```

::: details `docker-compose.test.yml` (Click to view Compose definition)
<<< ../../docker-compose.test.yml{yaml}
:::

The Garage service requires a configuration file mounted at `/etc/garage.toml`. You can use the repository's [`tests/fixtures/garage.toml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/tests/fixtures/garage.toml):

::: details `tests/fixtures/garage.toml` (Click to view Garage configuration)
<<< ../../tests/fixtures/garage.toml{toml}
:::

### Initializing Garage S3 Locally

After starting the container, initialize the layout and credentials:

```bash
# 1. Assign layout to the local node
NODE_ID=$(docker exec cloud-cache-garage /garage status | awk '/Node/ {print $2}')
docker exec -ti cloud-cache-garage /garage layout assign -z dc1 -c 10G $NODE_ID
docker exec -ti cloud-cache-garage /garage layout apply --version 1

# 2. Create access key and bucket
docker exec -ti cloud-cache-garage /garage key create ci-cache-key
docker exec -ti cloud-cache-garage /garage bucket create ci-cache
docker exec -ti cloud-cache-garage /garage bucket allow ci-cache --read --write --key ci-cache-key
```

## Notes

- **Checksums**: for this provider, the action sends request checksums only when S3 requires them, because many S3-compatible services reject the CRC checksums recent AWS SDKs send by default. Nothing to configure.
- **Expiry**: the action never deletes caches. Add a lifecycle rule that expires objects after 30–60 days so old caches do not accumulate.
