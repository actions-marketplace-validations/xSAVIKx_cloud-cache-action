# Migration Guide

Migrating from official `actions/cache` or legacy `tespkg/actions-cache` to `cloud-cache-action` takes less than 2 minutes.

## Migrating from `actions/cache` (v4, v5, v6)

Because `cloud-cache-action` maintains 1:1 input and output parity, you simply change the `uses:` line and add your bucket configuration:

### Before (`actions/cache`):

```yaml
- name: Cache dependencies
  uses: actions/cache@v4
  with:
    path: node_modules
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

### After (`cloud-cache-action`):

```yaml
- name: Cache dependencies
  uses: xSAVIKx/cloud-cache-action@v1
  with:
    # 1. Add your S3 bucket & credentials
    bucket: my-ci-cache-bucket
    endpoint: https://<account-id>.r2.cloudflarestorage.com # optional for AWS S3
    access-key: ${{ secrets.S3_ACCESS_KEY }}
    secret-key: ${{ secrets.S3_SECRET_KEY }}

    # 2. Keep all your existing inputs exactly as they are
    path: node_modules
    key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-node-
```

All existing features (`lookup-only`, `fail-on-cache-miss`, `enableCrossOsArchive`, `save-always`, `read-only`) continue to work identically.

---

## Migrating from `tespkg/actions-cache`

If you are using `tespkg/actions-cache`, you will notice immediate benefits:

1. Full support for active runner environments (Node 24) without deprecation warnings.
2. Official AWS SDK v3 instead of `minio-js`, avoiding known signing quirks with Cloudflare R2 and Fastly.
3. Windows runners produce clean POSIX forward-slash keys on S3 instead of broken backslashes.
4. Parity with `actions/cache@v6` features including `lookup-only`, `fail-on-cache-miss`, and `read-only`.

### Differences in Inputs:

- `bucket`, `endpoint`, `region`, `insecure`, `accessKey`, `secretKey`, `sessionToken` continue to be supported for full backward compatibility!
- We also support kebab-case aliases (`access-key`, `secret-key`, `session-token`, `force-path-style`).
- Fallback (`use-fallback`) is `false` by default in `cloud-cache-action` rather than `true`. If you want GitHub Cache fallback on cache miss, set `use-fallback: true`.
