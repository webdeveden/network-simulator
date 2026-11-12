#!/bin/sh
# Creates the Secret the cluster's pods read their credentials from. Values are random, are stored
# only in the cluster, and are never written to a file or printed. It does nothing if the Secret
# already exists: replacing it would lock the backend out of the existing Postgres database.
set -eu

NS=netsim
if kubectl -n "$NS" get secret netsim-secrets >/dev/null 2>&1; then
  echo "Secret netsim-secrets already exists, leaving it alone."
  exit 0
fi

user=netsim
db=netsim
password=$(openssl rand -hex 24)   # hex: safe to put inside the DATABASE_URL below

kubectl -n "$NS" create secret generic netsim-secrets \
  --from-literal=POSTGRES_USER="$user" \
  --from-literal=POSTGRES_PASSWORD="$password" \
  --from-literal=POSTGRES_DB="$db" \
  --from-literal=DATABASE_URL="postgresql+asyncpg://$user:$password@db:5432/$db" \
  --from-literal=NETSIM_SECRET_KEY="$(openssl rand -hex 32)"
