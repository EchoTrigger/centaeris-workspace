import logging

from asgiref.sync import sync_to_async
from django.http import JsonResponse
from ninja import Router

from app_core.models import (
    Artifact,
    DerivedRepresentation,
    SessionCitationProjection,
    SourceObject,
    UserLibraryObject,
)
from app_core.workspace_access import (
    source_access_is_at_least,
    workspace_membership_for,
)

from .security import session_auth
from .storage_stream import stored_file_response


logger = logging.getLogger(__name__)
router = Router(tags=["downloads"], by_alias=True)

CITATION_PREVIEW_CONTENT_TYPES = {
    "application/pdf",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/markdown",
    "text/plain",
}
@router.get(
    "/artifacts/{artifact_id}/download",
    auth=session_auth,
    response=None,
)
async def artifact_download(request, artifact_id: str):
    selected = await _select_artifact_download(request.user.id, artifact_id)
    return await _stream_selected(selected)


@router.get(
    "/source-objects/{source_object_id}/download",
    auth=session_auth,
    response=None,
)
async def source_object_download(request, source_object_id: str):
    selected = await _select_source_object_download(
        request.user.id,
        source_object_id,
    )
    return await _stream_selected(selected)


@router.get(
    "/library/{library_object_id}/download",
    auth=session_auth,
    response=None,
)
async def library_download(request, library_object_id: str):
    selected = await _select_library_object(
        request.user.id,
        library_object_id,
        preview=False,
    )
    return await _stream_selected(selected)


@router.get(
    "/library/{library_object_id}/preview",
    auth=session_auth,
    response=None,
)
async def library_preview(request, library_object_id: str):
    selected = await _select_library_object(
        request.user.id,
        library_object_id,
        preview=True,
    )
    return await _stream_selected(selected)


@router.get(
    "/citations/{citation_id}/preview",
    auth=session_auth,
    response=None,
)
async def citation_preview(request, citation_id: str):
    selected = await _select_citation_preview(request.user.id, citation_id)
    return await _stream_selected(selected)


async def _stream_selected(selected):
    if isinstance(selected, JsonResponse):
        return selected
    storage_key, content_type, filename, as_attachment, content_length = selected
    return await stored_file_response(
        storage_key,
        content_type,
        filename,
        as_attachment=as_attachment,
        content_length=content_length,
    )


@sync_to_async(thread_sensitive=True)
def _select_artifact_download(user_id: int, artifact_id: str):
    user = _user_for_id(user_id)
    try:
        artifact = Artifact.objects.select_related("agent_run", "session").get(
            id=artifact_id,
            agent_run__user_id=user_id,
            session__owner_id=user_id,
            status="published",
        )
    except Artifact.DoesNotExist:
        return JsonResponse({"error": "artifact_not_found"}, status=404)
    if workspace_membership_for(user, artifact.workspace_id) is None:
        return JsonResponse({"error": "artifact_not_found"}, status=404)
    return (
        artifact.storageKey,
        artifact.contentType,
        artifact.safeFilename,
        True,
        artifact.sizeBytes,
    )


@sync_to_async(thread_sensitive=True)
def _select_source_object_download(user_id: int, source_object_id: str):
    user = _user_for_id(user_id)
    try:
        item = SourceObject.objects.select_related("source").get(
            id=source_object_id,
        )
        membership = workspace_membership_for(user, item.workspace_id)
        if membership is None:
            raise SourceObject.DoesNotExist
        if not source_access_is_at_least(
            membership,
            item.source,
            "read",
        ):
            raise SourceObject.DoesNotExist
    except SourceObject.DoesNotExist:
        return JsonResponse({"error": "source_object_not_found"}, status=404)
    if item.source.status == "deleted":
        return JsonResponse({"error": "source_deleted"}, status=410)
    if item.status not in {"processing", "ready", "failed"}:
        return JsonResponse({"error": "source_object_not_found"}, status=404)
    return item.storageKey, item.contentType, item.displayName, True, item.sizeBytes


@sync_to_async(thread_sensitive=True)
def _select_library_object(user_id: int, library_object_id: str, *, preview: bool):
    filters = {
        "id": library_object_id,
        "owner_id": user_id,
    }
    if preview:
        filters |= {
            "status": "ready",
            "objectKind__in": {"file", "image", "note", "savedArtifact"},
        }
    else:
        filters["status__in"] = {"processing", "ready", "failed"}
    try:
        item = UserLibraryObject.objects.get(**filters)
    except UserLibraryObject.DoesNotExist:
        return JsonResponse({"error": "library_object_not_found"}, status=404)
    return (
        item.storageKey,
        item.contentType,
        item.displayName,
        not preview,
        item.sizeBytes,
    )


@sync_to_async(thread_sensitive=True)
def _select_citation_preview(user_id: int, citation_id: str):
    user = _user_for_id(user_id)
    try:
        citation = SessionCitationProjection.objects.select_related("workspace", "session").get(
            citationId=citation_id,
            agent_run__user_id=user_id,
        )
    except SessionCitationProjection.DoesNotExist:
        return JsonResponse({"error": "citation_not_found"}, status=404)
    membership = workspace_membership_for(user, citation.workspace_id)
    if membership is None:
        return JsonResponse({"error": "citation_not_found"}, status=404)

    if citation.ownerKind == "sourceObject":
        try:
            item = SourceObject.objects.select_related("source").get(
                id=citation.ownerRef,
                workspace=citation.workspace,
                objectType="file",
            )
        except SourceObject.DoesNotExist:
            return JsonResponse(
                {"error": "citation_source_not_available"},
                status=404,
            )
        if not source_access_is_at_least(
            membership,
            item.source,
            "read",
        ):
            return JsonResponse(
                {"error": "citation_source_not_available"},
                status=404,
            )
        if item.source.status == "deleted":
            return JsonResponse({"error": "source_deleted"}, status=410)
        if item.status != "ready":
            return JsonResponse(
                {"error": "citation_source_not_available"},
                status=404,
            )
    elif citation.ownerKind == "userLibraryObject":
        try:
            item = UserLibraryObject.objects.get(
                id=citation.ownerRef,
                owner_id=user_id,
                status="ready",
                objectKind__in={"file", "image", "note", "savedArtifact"},
            )
        except UserLibraryObject.DoesNotExist:
            return JsonResponse(
                {"error": "citation_source_not_available"},
                status=404,
            )
    elif citation.ownerKind == "artifact":
        try:
            item = Artifact.objects.get(
                id=citation.ownerRef,
                workspace=citation.workspace,
                session=citation.session,
                agent_run__user_id=user_id,
                status="published",
            )
        except Artifact.DoesNotExist:
            return JsonResponse(
                {"error": "citation_source_not_available"},
                status=404,
            )
    else:
        logger.error(
            "Citation projection has an unsupported owner kind",
            extra={
                "citationId": citation.citationId,
                "ownerKind": citation.ownerKind,
            },
        )
        return JsonResponse({"error": "citation_owner_kind_invalid"}, status=409)

    if item.sha256 != citation.ownerSha256:
        return JsonResponse({"error": "citation_source_stale"}, status=409)
    if citation.representationId:
        if item.contentGeneration != citation.ownerGeneration:
            return JsonResponse({"error": "citation_source_stale"}, status=409)
        try:
            representation = DerivedRepresentation.objects.get(
                representationId=citation.representationId,
                ownerKind=citation.ownerKind,
                ownerId=citation.ownerRef,
                ownerContentGeneration=citation.ownerGeneration,
                ownerSha256=citation.ownerSha256,
                processingSpecification_id=citation.specDigest,
            )
        except DerivedRepresentation.DoesNotExist:
            return JsonResponse(
                {"error": "citation_representation_not_available"}, status=404
            )
        if representation.previewPdfKey:
            return (
                representation.previewPdfKey,
                "application/pdf",
                item.displayName,
                False,
                representation.previewPdfSizeBytes,
            )
        content_type = item.contentType.partition(";")[0].strip().lower()
        if content_type != "application/pdf" and not content_type.startswith("image/"):
            return (
                representation.canonicalTextKey,
                "text/markdown",
                f"{item.displayName}.md",
                False,
                representation.canonicalTextSizeBytes,
            )
    content_type = item.contentType.partition(";")[0].strip().lower()
    if content_type in CITATION_PREVIEW_CONTENT_TYPES:
        return item.storageKey, content_type, item.displayName, False, item.sizeBytes
    return JsonResponse({"error": "citation_preview_unsupported"}, status=415)


def _user_for_id(user_id: int):
    from django.contrib.auth import get_user_model

    return get_user_model().objects.get(id=user_id)
