from ninja import Router, Status

from app_core.models import SessionCitationProjection
from app_core.workspace_access import workspace_membership_for

from .response_schema import CitationEnvelope, COMMON_ERROR_RESPONSES
from .security import session_auth


router = Router(tags=["citations"], by_alias=True)


@router.get(
    "/citations/{citation_id}",
    auth=session_auth,
    response={200: CitationEnvelope} | COMMON_ERROR_RESPONSES,
)
def citation_detail(request, citation_id: str):
    try:
        citation = SessionCitationProjection.objects.select_related("agent_run").get(
            citationId=citation_id,
            agent_run__user=request.user,
        )
    except SessionCitationProjection.DoesNotExist:
        return Status(404, {"error": "citation_not_found"})
    if workspace_membership_for(request.user, citation.workspace_id) is None:
        return Status(404, {"error": "citation_not_found"})
    download_path = {
        "sourceObject": "source-objects",
        "userLibraryObject": "library",
        "artifact": "artifacts",
    }.get(citation.ownerKind)
    if download_path is None:
        return Status(409, {"error": "citation_owner_kind_invalid"})
    return {
        "citation": {
            "citationId": citation.citationId,
            "inputRef": citation.inputRef,
            "displayName": citation.displayName,
            "evidenceKind": citation.evidenceKind,
            "locator": citation.locator,
            "sourceUrl": f"/api/citations/{citation.citationId}",
            "previewUrl": f"/api/citations/{citation.citationId}/preview",
            "downloadUrl": f"/api/{download_path}/{citation.ownerRef}/download",
            "originLabel": "库",
        }
    }
