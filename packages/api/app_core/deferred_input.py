from copy import deepcopy

from django.conf import settings
from django.core.files.storage import default_storage

from .assets import (
    DeferredInputResolutionError,
    allocated_virtual_paths,
    resolved_input_for_link,
)
from .models import SessionAssetLink
from .runtime_contract import (
    authorization_digest,
    _verify_authorization_digest_signature,
    agent_run_binding_matches,
)
from .workspace_access import agent_run_membership_is_current


class DeferredInputBindingError(RuntimeError):
    pass


def resolve_deferred_input(agent_run, input_ref: str, expected_authorization_digest: str) -> dict:
    return _current_input(agent_run, input_ref, expected_authorization_digest)["resolvedInput"]


def resolved_input_storage(
    agent_run, input_ref: str, expected_authorization_digest: str
) -> tuple[dict, str]:
    current = _current_input(agent_run, input_ref, expected_authorization_digest)
    return current["resolvedInput"], current["storageKey"]


def input_storage_batch(agent_run, expected_authorization_digest: str):
    """A resolver owned by one request, never shared across tool calls."""
    verified = []

    def resolve(input_ref):
        current = _current_input(agent_run, input_ref, expected_authorization_digest, verified)
        return current["resolvedInput"], current["storageKey"]

    return resolve


def _current_input(agent_run, input_ref: str, expected_authorization_digest: str, verified=None) -> dict:
    if not agent_run_membership_is_current(agent_run):
        raise DeferredInputBindingError("AgentRun WorkspaceMembership is no longer current")
    authorization = agent_run.authorization
    # Cache only signed immutable facts, never membership or resource access.
    # Detect even in-place payload/signature changes before reusing the proof.
    candidate = (authorization.payload, authorization.digest, authorization.signature,
                 settings.AGENT_RUN_AUTHORIZATION_SIGNING_KEY, expected_authorization_digest)
    if verified is None or not verified or verified[0] != candidate:
        digest = authorization_digest(authorization.payload)
        if digest != authorization.digest or digest != expected_authorization_digest:
            raise DeferredInputBindingError("AgentRun authorization digest mismatch")
        try:
            _verify_authorization_digest_signature(
                digest,
                settings.AGENT_RUN_AUTHORIZATION_SIGNING_KEY,
                authorization.signature,
            )
        except ValueError as error:
            raise DeferredInputBindingError("AgentRun authorization signature mismatch") from error
        if verified is not None:
            verified[:] = [deepcopy(candidate)]
    if not agent_run_binding_matches(authorization.payload, agent_run):
        raise DeferredInputBindingError("AgentRun authorization binding mismatch")
    declared = next(
        (
            item
            for item in authorization.payload["assetRefs"]
            if item["inputRef"] == input_ref
        ),
        None,
    )
    if declared is None:
        raise DeferredInputResolutionError("asset_unavailable")
    try:
        link = SessionAssetLink.objects.select_related(
            "sourceObject__source",
            "userLibraryObject",
            "artifact",
        ).get(
            id=input_ref,
            workspace_id=agent_run.workspace_id,
            session_id=agent_run.session_id,
            attachedBy_id=agent_run.user_id,
        )
    except SessionAssetLink.DoesNotExist as error:
        raise DeferredInputResolutionError("asset_unavailable") from error
    resolved = resolved_input_for_link(
        agent_run,
        link,
        allocated_virtual_paths(agent_run)[input_ref],
    )
    if (
        resolved["displayName"] != declared["displayName"]
        or resolved["contentType"] != declared["contentType"]
        or resolved["ownerKind"] != declared["inputIdentity"]["ownerKind"]
        or resolved["objectRef"] != declared["inputIdentity"]["ownerId"]
        or resolved["sourceVersion"] != str(declared["inputIdentity"]["generation"])
        or resolved["sha256"] != declared["inputIdentity"]["sha256"]
        or resolved["sizeBytes"] != declared["sizeBytes"]
    ):
        raise DeferredInputBindingError(
            "resolved input identity changed after AgentRun authorization"
        )
    owner = link.sourceObject or link.userLibraryObject or link.artifact
    storage_key = owner.storageKey
    if not storage_key or not default_storage.exists(storage_key):
        raise DeferredInputResolutionError("asset_unavailable")
    return {"resolvedInput": resolved, "storageKey": storage_key}
