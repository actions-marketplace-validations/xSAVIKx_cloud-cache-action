# Garage S3 Setup

[Garage](https://garagehq.deuxfleurs.fr/) is an open-source, lightweight distributed S3-compatible storage system designed to be self-hosted with minimal resource usage.

## Configuration

When running self-hosted runners or local CI infrastructure with Garage:

```yaml
- name: Cache dependencies using self-hosted Garage
  uses: serhiichuk/cloud-cache-action@v1
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

You can spin up Garage locally using the repository's `docker-compose.test.yml`:

```bash
docker compose -f docker-compose.test.yml up -d garage
```
