#!/bin/sh
# Installs (or updates) Prometheus, Grafana and the exporters in the local cluster. The alert rules
# and the dashboard are read from monitoring/, the same files compose uses, so the two never drift.
# Safe to run again after changing any of those files.
set -eu

NS=netsim
cd "$(dirname "$0")/../.."

context=$(kubectl config current-context)
if [ "$context" != "kind-netsim" ]; then
  echo "kubectl is pointing at \"$context\", not kind-netsim. Stopping." >&2
  exit 1
fi

# Grafana's admin password: random and kept only in the cluster, like create-secret.sh
if ! kubectl -n "$NS" get secret grafana-admin >/dev/null 2>&1; then
  kubectl -n "$NS" create secret generic grafana-admin --from-literal=password="$(openssl rand -hex 16)"
fi

# ConfigMaps built from files. "create --dry-run | apply" turns create into create-or-update.
configmap() {
  name=$1
  shift
  kubectl -n "$NS" create configmap "$name" "$@" --dry-run=client -o yaml | kubectl apply -f -
}
configmap prometheus-config \
  --from-file=prometheus.yml=k8s/monitoring/config/prometheus.yml \
  --from-file=alerts.yml=monitoring/prometheus/alerts.yml
configmap grafana-datasources --from-file=monitoring/grafana/provisioning/datasources/prometheus.yml
configmap grafana-dashboard-providers --from-file=monitoring/grafana/provisioning/dashboards/netsim.yml
configmap grafana-dashboards --from-file=monitoring/grafana/dashboards/netsim.json

kubectl apply -f k8s/monitoring/rbac.yaml -f k8s/monitoring/exporters.yaml \
  -f k8s/monitoring/prometheus.yaml -f k8s/monitoring/grafana.yaml

# Prometheus and Grafana read their config files at startup, so restart them to pick up changes
kubectl -n "$NS" rollout restart deployment/prometheus deployment/grafana
for d in redis-exporter postgres-exporter prometheus grafana; do
  kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s
done

cat <<'EOF'

Monitoring is running. It's private to the cluster, so open it through a port-forward:
  kubectl -n netsim port-forward svc/grafana 3001:3000      then http://localhost:3001 (user admin)
  kubectl -n netsim port-forward svc/prometheus 9091:9090   then http://localhost:9091
Grafana password:
  kubectl -n netsim get secret grafana-admin -o jsonpath='{.data.password}' | base64 -d; echo
EOF
