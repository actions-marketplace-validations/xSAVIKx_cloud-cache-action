# AWS S3 Setup

Cloud Cache Action supports AWS S3 out of the box using both static credentials and GitHub Actions OIDC (OpenID Connect) with IAM Roles.

## Option A: GitHub Actions OIDC (Recommended)

Using OIDC avoids managing long-lived static AWS access keys:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Configure AWS Credentials via OIDC
        uses: aws-actions/configure-aws-credentials@cbe3b392738ccf3f987d68400dafcf4b0624a56c # v6.2.4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsCacheRole
          aws-region: us-east-1

      - name: Cache dependencies
        uses: xSAVIKx/cloud-cache-action@v1
        with:
          bucket: my-actions-cache-bucket
          key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
          path: node_modules
```

## Option B: Static IAM Credentials

```yaml
- name: Cache dependencies
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    bucket: my-actions-cache-bucket
    region: us-east-1
    access-key: ${{ secrets.AWS_ACCESS_KEY_ID }}
    secret-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    key: ${{ runner.os }}-build-${{ hashFiles('**/lock') }}
    path: node_modules
```

## Recommended S3 Bucket Lifecycle Rule

To prevent cache storage costs from growing unbounded, configure an S3 Lifecycle rule on your bucket:

- **Rule action**: Expire current versions of objects
- **Days after object creation**: `30` or `60` days

## Live CI Verification Workflow

This action is tested continuously against real AWS S3 storage. You can inspect the live GitHub Actions workflow file in the repository: [`.github/workflows/provider-aws-s3.yml`](https://github.com/xSAVIKx/cloud-cache-action/blob/main/.github/workflows/provider-aws-s3.yml).

::: details `.github/workflows/provider-aws-s3.yml` (Click to view full workflow)
<<< ../../.github/workflows/provider-aws-s3.yml{yaml}
:::

