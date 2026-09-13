#!/usr/bin/env bash
# Bootstraps the single-node Garage from docker-compose.test.yml: assigns a layout,
# imports the fixed CI key and creates the test bucket. Safe to run more than once.
set -euo pipefail

CONTAINER="${GARAGE_CONTAINER:-cloud-cache-garage}"
BUCKET="${TEST_S3_BUCKET:-cloud-cache-test}"
KEY_ID='GK0123456789abcdef01234567'
SECRET='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

garage() { docker exec "$CONTAINER" /garage "$@"; }

for _ in $(seq 1 30); do
  if garage status >/dev/null 2>&1; then break; fi
  sleep 1
done

NODE_ID="$(garage node id -q | cut -d@ -f1)"
if ! garage layout show | grep -q 'dc1'; then
  garage layout assign -z dc1 -c 1G "$NODE_ID"
  garage layout apply --version 1
fi
garage key info "$KEY_ID" >/dev/null 2>&1 || garage key import --yes -n cloud-cache-ci "$KEY_ID" "$SECRET"
garage bucket info "$BUCKET" >/dev/null 2>&1 || garage bucket create "$BUCKET"
garage bucket allow --read --write --owner "$BUCKET" --key "$KEY_ID"
echo "Garage ready: bucket $BUCKET, key $KEY_ID"
