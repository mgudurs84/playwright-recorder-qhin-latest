# CDR Observability — GKE Deployment Guide

Deploy the CDR Observability app (CommonWell Playwright Recorder) to Google Kubernetes Engine.

## Prerequisites

| Tool | Version |
|---|---|
| `gcloud` CLI | Latest |
| `kubectl` | 1.28+ |
| `docker` | 24+ |
| GKE cluster | Standard or Autopilot, Node pool with ≥ 4 CPU / 8 GB RAM recommended |
| Google Artifact Registry | Enabled on your GCP project |

---

## 1 — One-time cluster setup

```bash
# Authenticate
gcloud auth login
gcloud config set project YOUR_GCP_PROJECT_ID

# Get cluster credentials
gcloud container clusters get-credentials YOUR_CLUSTER_NAME \
  --region YOUR_REGION \
  --project YOUR_GCP_PROJECT_ID

# Verify
kubectl get nodes
```

---

## 2 — Build and push the Docker image

```bash
# Set your Artifact Registry path
export REGISTRY="us-docker.pkg.dev/YOUR_GCP_PROJECT_ID/YOUR_REPO"
export IMAGE="$REGISTRY/cdr-observability"
export TAG="$(git rev-parse --short HEAD)"    # pin to git commit

# Build from the repo root (Dockerfile is in k8s/)
docker build -f k8s/Dockerfile -t $IMAGE:$TAG -t $IMAGE:latest .

# Push
gcloud auth configure-docker us-docker.pkg.dev
docker push $IMAGE:$TAG
docker push $IMAGE:latest
```

---

## 3 — Prepare secrets

**Do NOT commit real values.** Populate `k8s/secret.yaml` locally, apply it, then discard.

```bash
# Encode each value
echo -n 'your-cw-username@cvs.com'  | base64    # → cw-username value
echo -n 'your-portal-password'       | base64    # → cw-password value
cat your-gcp-sa.json | base64 -w 0              # → gcp-service-account-json value
```

Edit `k8s/secret.yaml` and replace the `<BASE64_...>` placeholders, then:

```bash
kubectl apply -f k8s/secret.yaml
```

---

## 4 — Update the image reference in deployment.yaml

Open `k8s/deployment.yaml` and replace both occurrences of:

```
YOUR_REGISTRY/cdr-observability:latest
```

with your actual image path, e.g.:

```
us-docker.pkg.dev/YOUR_GCP_PROJECT_ID/YOUR_REPO/cdr-observability:abc1234
```

---

## 5 — Apply all manifests

```bash
# Apply in order
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

# Or apply the whole directory at once
kubectl apply -f k8s/ -n cdr-observability
```

---

## 6 — Verify the deployment

```bash
# Watch pods come up (takes 60–90 s for Playwright image to pull)
kubectl get pods -n cdr-observability -w

# Check both containers (api-server + frontend/nginx) are Ready
kubectl describe pod -n cdr-observability -l app=cdr-observability

# Check logs
kubectl logs -n cdr-observability -l app=cdr-observability -c api-server   --tail=50
kubectl logs -n cdr-observability -l app=cdr-observability -c frontend --tail=20

# Get the internal VPC IP assigned by the LoadBalancer
kubectl get svc cdr-observability -n cdr-observability
```

The app is available at `http://<EXTERNAL-IP>/` once the LoadBalancer IP is assigned
(typically 1–2 minutes on GKE).

---

## Architecture in the cluster

```
VPC Internal LoadBalancer (port 80)
        │
        ▼
┌───────────────────── Pod: cdr-observability ──────────────────────┐
│                                                                     │
│  Container: frontend (nginx:alpine)          port 80               │
│    /         → serves React SPA              (PVC: frontend-dist)  │
│    /api/*    → proxy_pass localhost:3000                           │
│                                                                     │
│  Container: api-server (Playwright/Node)     port 3000             │
│    Express + Playwright + node-cron                                 │
│    /data/snapshots/   → PVC (hourly-snapshots.json)                │
│    /tmp/cw-sessions/  → PVC (Playwright session cookies)           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
        │
        ▼
PersistentVolumeClaim: cdr-data-pvc (2 Gi, ReadWriteOnce)
```

---

## Updates (rolling restart, zero downtime)

```bash
# Build + push new image
docker build -f k8s/Dockerfile -t $IMAGE:$NEW_TAG .
docker push $IMAGE:$NEW_TAG

# Update the image in the Deployment
kubectl set image deployment/cdr-observability \
  api-server=$IMAGE:$NEW_TAG \
  copy-frontend=$IMAGE:$NEW_TAG \
  -n cdr-observability

# Watch the rollout
kubectl rollout status deployment/cdr-observability -n cdr-observability
```

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Pod stuck in `Pending` | `kubectl describe pvc cdr-data-pvc -n cdr-observability` — StorageClass may differ |
| `ImagePullBackOff` | Check Artifact Registry permissions: `gcloud artifacts repositories get-iam-policy` |
| API returns 502 | api-server not ready yet; check `kubectl logs … -c api-server` for Chromium errors |
| Hourly monitor shows `auth_required` | Session cookie expired — run the PAR Demo once from the UI to re-authenticate |
| OTP required on every restart | PVC not mounted correctly — session cookies not persisting across restarts |

---

## Important: Single-replica constraint

The Deployment is hard-set to `replicas: 1`. **Do not scale this up.**

The Playwright browser session and the `node-cron` hourly scheduler live in memory.
Multiple replicas would cause:
- Two browsers competing for the same CommonWell authenticated session
- Two cron jobs firing simultaneously, corrupting the `hourly-snapshots.json` file

If you need high availability, consider extracting the scheduler to a separate
Kubernetes `CronJob` resource and exposing only the read API via multiple replicas.
