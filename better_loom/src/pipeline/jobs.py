"""
Job Manager using Firestore

Tracks personalization job state and progress.
"""

from google.cloud import firestore
from datetime import datetime
from loguru import logger
from typing import Optional

from ..config import settings
from ..models import PersonalizationJob, JobStatus, PersonalizationData


class JobManager:
    """
    Manages personalization jobs in Firestore.

    Each job document contains:
    - Template reference
    - Personalization data
    - Status and progress
    - Output URLs when complete
    """

    def __init__(self):
        self.db = firestore.Client(project=settings.gcp_project_id)
        self.collection = self.db.collection(settings.firestore_collection)

    def create_job(
        self,
        template_id: str,
        personalization: PersonalizationData,
    ) -> PersonalizationJob:
        """
        Create a new personalization job.

        Returns the job with a generated ID.
        """
        # Generate document reference (auto-ID)
        doc_ref = self.collection.document()

        job = PersonalizationJob(
            id=doc_ref.id,
            template_id=template_id,
            personalization=personalization,
            status=JobStatus.PENDING,
            progress=0,
            created_at=datetime.utcnow(),
        )

        # Save to Firestore
        doc_ref.set(job.model_dump(mode="json"))

        logger.info(f"Created job {job.id} for template {template_id}")
        return job

    def get_job(self, job_id: str) -> Optional[PersonalizationJob]:
        """Get a job by ID."""
        doc = self.collection.document(job_id).get()

        if not doc.exists:
            return None

        return PersonalizationJob(**doc.to_dict())

    def update_status(
        self,
        job_id: str,
        status: JobStatus,
        progress: int = None,
        error_message: str = None,
    ):
        """Update job status and progress."""
        updates = {
            "status": status.value,
        }

        if progress is not None:
            updates["progress"] = progress

        if error_message is not None:
            updates["error_message"] = error_message

        if status == JobStatus.COMPLETED:
            updates["completed_at"] = datetime.utcnow().isoformat()

        self.collection.document(job_id).update(updates)
        logger.debug(f"Job {job_id}: {status.value} ({progress}%)")

    def set_output(self, job_id: str, output_url: str):
        """Set the output URL for a completed job."""
        self.collection.document(job_id).update({
            "output_url": output_url,
            "status": JobStatus.COMPLETED.value,
            "progress": 100,
            "completed_at": datetime.utcnow().isoformat(),
        })
        logger.info(f"Job {job_id} complete: {output_url}")

    def fail_job(self, job_id: str, error_message: str):
        """Mark a job as failed."""
        self.collection.document(job_id).update({
            "status": JobStatus.FAILED.value,
            "error_message": error_message,
        })
        logger.error(f"Job {job_id} failed: {error_message}")

    def list_jobs(
        self,
        template_id: str = None,
        status: JobStatus = None,
        limit: int = 100,
    ) -> list[PersonalizationJob]:
        """List jobs with optional filters."""
        query = self.collection

        if template_id:
            query = query.where("template_id", "==", template_id)

        if status:
            query = query.where("status", "==", status.value)

        query = query.order_by("created_at", direction=firestore.Query.DESCENDING)
        query = query.limit(limit)

        docs = query.stream()
        return [PersonalizationJob(**doc.to_dict()) for doc in docs]

    def delete_job(self, job_id: str):
        """Delete a job."""
        self.collection.document(job_id).delete()
        logger.info(f"Deleted job {job_id}")


class TemplateManager:
    """
    Manages video templates in Firestore.
    """

    def __init__(self):
        self.db = firestore.Client(project=settings.gcp_project_id)
        self.collection = self.db.collection("video_templates")

    def save_template(self, template: "VideoTemplate") -> str:
        """Save a template, returns template ID."""
        from ..models import VideoTemplate

        doc_ref = self.collection.document(template.id)
        doc_ref.set(template.model_dump(mode="json"))

        logger.info(f"Saved template {template.id}")
        return template.id

    def get_template(self, template_id: str) -> Optional["VideoTemplate"]:
        """Get a template by ID."""
        from ..models import VideoTemplate

        doc = self.collection.document(template_id).get()

        if not doc.exists:
            return None

        return VideoTemplate(**doc.to_dict())

    def list_templates(self) -> list["VideoTemplate"]:
        """List all templates."""
        from ..models import VideoTemplate

        docs = self.collection.stream()
        return [VideoTemplate(**doc.to_dict()) for doc in docs]

    def delete_template(self, template_id: str):
        """Delete a template."""
        self.collection.document(template_id).delete()
        logger.info(f"Deleted template {template_id}")
