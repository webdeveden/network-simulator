#!/bin/sh
# Ships the current code to the local kind cluster: build, load, migrate, then a rolling update.
# Each image is tagged with the commit, so every version stays on the node and
# `kubectl -n netsim rollout undo deployment/backend` can go back to the previous one.
set -eu

NS=netsim
CLUSTER=netsim
cd "$(dirname "$0")/.."

# Only ever the local cluster: kubectl may point at a real one later
context=$(kubectl config current-context)
if [ "$context" != "kind-$CLUSTER" ]; then
  echo "kubectl is pointing at \"$context\", not kind-$CLUSTER. Stopping." >&2
  exit 1
fi

# Uncommitted changes get their own tag, so an image never claims to be a commit it isn't
TAG=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain -- backend frontend)" ]; then
  TAG="$TAG-dirty-$(date +%H%M%S)"
fi
echo "== Deploying $TAG"

echo "== 1/5 Building images"
docker build -t "netsim-backend:$TAG" backend
docker build -t "netsim-frontend:$TAG" frontend

echo "== 2/5 Loading them onto the node"
kind load docker-image "netsim-backend:$TAG" "netsim-frontend:$TAG" --name "$CLUSTER"

# Before the new code runs: new code may need the new tables. A Job can't be edited, so
# replace it, with the image swapped in. alembic skips migrations that are already applied.
echo "== 3/5 Running migrations"
kubectl -n "$NS" delete job migrate --ignore-not-found
sed "s|image: netsim-backend:local|image: netsim-backend:$TAG|" k8s/31-migrate-job.yaml | kubectl apply -f -
if ! kubectl -n "$NS" wait --for=condition=complete job/migrate --timeout=180s; then
  echo "Migrations failed, so the running version was left alone. See: kubectl -n $NS logs job/migrate" >&2
  exit 1
fi

echo "== 4/5 Rolling update"
kubectl -n "$NS" set image deployment/backend "backend=netsim-backend:$TAG"
kubectl -n "$NS" set image deployment/frontend "frontend=netsim-frontend:$TAG"
kubectl -n "$NS" rollout status deployment/backend --timeout=180s
kubectl -n "$NS" rollout status deployment/frontend --timeout=180s

echo "== 5/5 Done"
kubectl -n "$NS" get pods -l 'app in (backend,frontend)'
echo "Undo with: kubectl -n $NS rollout undo deployment/backend (and deployment/frontend)"
