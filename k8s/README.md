# NetSim on Kubernetes (local, with kind)

Runs the app on a local cluster: 2 backend pods, 1 frontend, Postgres and Redis.
Open it at http://localhost:8091. It doesn't touch the compose stack on :8090.

| File | What it creates |
|---|---|
| `cluster/kind-config.yaml` | The cluster itself, and the Mac port 8091 mapping (not applied with kubectl) |
| `00-namespace.yaml` | The `netsim` namespace |
| `10-config.yaml` | ConfigMaps: app settings and the Kubernetes nginx config |
| `create-secret.sh` | The Secret: random credentials, stored only in the cluster |
| `20-postgres.yaml` | Postgres StatefulSet with a 1Gi disk, Service `db` |
| `21-redis.yaml` | Redis Deployment and Service |
| `30-backend.yaml` | Backend Deployment (2 pods) and internal Service |
| `31-migrate-job.yaml` | Job that runs `alembic upgrade head` once |
| `40-frontend.yaml` | Frontend Deployment and NodePort Service, the only way in |

## First run

```bash
kind create cluster --name netsim --config k8s/cluster/kind-config.yaml

# Published images are amd64 only for now, so build for this Mac and load them into the cluster
docker build -t netsim-backend:local backend
docker build -t netsim-frontend:local frontend
kind load docker-image netsim-backend:local netsim-frontend:local --name netsim

kubectl apply -f k8s/00-namespace.yaml
sh k8s/create-secret.sh
kubectl apply -f k8s/
```

The backend starts while migrations are still running, so wait for the Job before using the app:
`kubectl -n netsim wait --for=condition=complete job/migrate --timeout=180s`.

## Everyday commands

```bash
kubectl -n netsim get pods                     # what's running
kubectl -n netsim logs deploy/backend          # logs (one pod)
kubectl -n netsim describe pod <name>          # why a pod won't start: read Events at the bottom
kubectl -n netsim exec deploy/redis -- redis-cli --scan --pattern '*'
```

## After changing code

```bash
sh k8s/deploy-local.sh
```

It builds both images tagged with the commit, loads them onto the node, runs the migrations, then does
a rolling update. Go back to the previous version with:

```bash
kubectl -n netsim rollout undo deployment/backend
kubectl -n netsim rollout undo deployment/frontend
```

The YAML files still say `:local`, so `kubectl apply -f k8s/` puts the version from the first run back.

## Stop and clean up

`kind delete cluster --name netsim` removes the cluster and all its data. Nothing else is affected.
