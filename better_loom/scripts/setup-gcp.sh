#!/bin/bash
# Setup GCP resources for the personalization engine
#
# Usage: ./scripts/setup-gcp.sh <project-id> <region>

set -e

PROJECT_ID=${1:-$(gcloud config get-value project)}
REGION=${2:-us-central1}
BUCKET_NAME="${PROJECT_ID}-personalization"
SERVICE_ACCOUNT="personalization-engine"

echo "Setting up GCP resources..."
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Bucket: $BUCKET_NAME"

# Enable required APIs
echo "Enabling APIs..."
gcloud services enable \
    run.googleapis.com \
    cloudbuild.googleapis.com \
    firestore.googleapis.com \
    storage.googleapis.com \
    secretmanager.googleapis.com \
    --project=$PROJECT_ID

# Create Cloud Storage bucket
echo "Creating storage bucket..."
gsutil mb -l $REGION gs://$BUCKET_NAME || echo "Bucket already exists"

# Create Firestore database (if not exists)
echo "Setting up Firestore..."
gcloud firestore databases create \
    --location=$REGION \
    --project=$PROJECT_ID 2>/dev/null || echo "Firestore already configured"

# Create service account
echo "Creating service account..."
gcloud iam service-accounts create $SERVICE_ACCOUNT \
    --display-name="Personalization Engine" \
    --project=$PROJECT_ID 2>/dev/null || echo "Service account exists"

SA_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"

# Grant permissions
echo "Granting permissions..."
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/storage.objectAdmin" \
    --quiet

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/datastore.user" \
    --quiet

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet

# Create secrets for API keys
echo ""
echo "Creating secrets..."
echo "Please enter your ElevenLabs API key:"
read -s ELEVENLABS_KEY

echo -n "$ELEVENLABS_KEY" | gcloud secrets create elevenlabs-api-key \
    --data-file=- \
    --project=$PROJECT_ID 2>/dev/null || \
    echo -n "$ELEVENLABS_KEY" | gcloud secrets versions add elevenlabs-api-key --data-file=-

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "1. Create .env file:"
echo "   GCP_PROJECT_ID=$PROJECT_ID"
echo "   GCP_REGION=$REGION"
echo "   GCS_BUCKET=$BUCKET_NAME"
echo "   ELEVENLABS_API_KEY=<from Secret Manager>"
echo ""
echo "2. Deploy to Cloud Run:"
echo "   gcloud builds submit --config cloudbuild.yaml \\"
echo "     --substitutions=_REGION=$REGION,_SERVICE_NAME=personalization-engine"
