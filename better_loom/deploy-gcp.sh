#!/bin/bash
# Deploy Soron API to Google Cloud Run

set -e

PROJECT_ID="${GCP_PROJECT_ID:-soron-video-loom}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="soron-api"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "🚀 Deploying Soron API to Cloud Run..."
echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"

# Build and push container
echo "📦 Building container..."
gcloud builds submit --tag ${IMAGE_NAME} .

# Deploy to Cloud Run
echo "🌐 Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
  --image ${IMAGE_NAME} \
  --platform managed \
  --region ${REGION} \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --concurrency 10 \
  --min-instances 0 \
  --max-instances 10 \
  --allow-unauthenticated \
  --set-env-vars "ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY}" \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"

# Get the URL
URL=$(gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format 'value(status.url)')
echo ""
echo "✅ Deployed successfully!"
echo "🔗 API URL: ${URL}"
echo ""
echo "Update your frontend .env with:"
echo "NEXT_PUBLIC_API_URL=${URL}/api"
