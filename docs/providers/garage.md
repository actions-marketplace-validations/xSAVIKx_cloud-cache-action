# Garage S3 Setup

[Garage](https://garagehq.deuxfleurs.fr/) is an open-source, lightweight distributed S3-compatible storage system designed to be self-hosted with minimal resource usage.

## Configuration

When running self-hosted runners or local CI infrastructure with Garage:

```yaml
- name: Cache dependencies using self-hosted Garage
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: ci-cache
    endpoint: http://garage.internal:3900 # Or your public/private Garage S3 URL
    provider: garage
    access-key: ${{ secrets.GARAGE_ACCESS_KEY }}
    secret-key: ${{ secrets.GARAGE_SECRET_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: build/
```

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

