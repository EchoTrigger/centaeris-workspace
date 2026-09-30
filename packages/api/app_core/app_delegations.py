"""User-owned delegated app access to existing hosted resources."""
import hashlib
import re

from django.contrib.auth import get_user_model
from django.utils import timezone

from .app_delegation_contract import AUDIENCE, ISSUER, SCOPES
from .agent_definitions import available_agent_definitions
from .models import Agent, AgentRun, Artifact, BusinessApplication, HostedOperationReceipt, Session, SessionAssetLink, SessionCitationProjection, UserAppDelegation
from .workspace_access import workspace_membership_for


class DelegationRejected(Exception):
    def __init__(self, code, status=403):
        self.code, self.status = code, status
        super().__init__(code)


def token_digest(token):
    return "sha256:" + hashlib.sha256(token.encode("ascii")).hexdigest()


def require_current_delegation(delegation_id, scope=None, *, lock=False):
    if scope is not None and scope not in SCOPES:
        raise ValueError("unknown delegation scope")
    query = UserAppDelegation.objects.select_related("user", "app", "workspace", "definition")
    if lock:
        app_id = UserAppDelegation.objects.filter(id=delegation_id).values_list("app_id", flat=True).first()
        BusinessApplication.objects.select_for_update().filter(id=app_id).first()
        query = query.select_for_update(of=("self",))
    grant = query.filter(id=delegation_id).first()
    if (grant is None or not grant.user.is_active or grant.app.status != "active"
            or grant.revoked_at is not None or grant.expires_at <= timezone.now()
            or grant.issuer != ISSUER or grant.audience != AUDIENCE
            or grant.definition.workspace_id != grant.workspace_id):
        raise DelegationRejected("delegation_not_available")
    membership = workspace_membership_for(grant.user, grant.workspace_id)
    if (membership is None or membership.id != grant.membership_ref
            or not available_agent_definitions(membership).filter(id=grant.definition_id).exists()):
        raise DelegationRejected("delegation_not_available")
    if scope is not None and scope not in grant.scopes:
        raise DelegationRejected("delegation_scope_forbidden")
    return grant


def authenticate_delegation(token, scope):
    if not isinstance(token, str) or re.fullmatch(r"cwa_[A-Za-z0-9_-]{43}", token) is None:
        raise DelegationRejected("delegation_invalid", 401)
    delegation_id = UserAppDelegation.objects.filter(token_digest=token_digest(token)).values_list("id", flat=True).first()
    if delegation_id is None:
        raise DelegationRejected("delegation_invalid", 401)
    return require_current_delegation(delegation_id, scope)


def require_delegated_agent(grant, agent_id, *, require_active=True):
    query = Agent.objects.filter(id=agent_id, workspace_id=grant.workspace_id, owner_id=grant.user_id,
                                 definition_id=grant.definition_id)
    if require_active:
        query = query.filter(status="active")
    agent = query.first()
    if agent is None:
        raise DelegationRejected("agent_not_found", 404)
    return agent


def require_delegated_session(grant, session_id, *, require_active=True):
    query = Session.objects.filter(id=session_id, workspace_id=grant.workspace_id, owner_id=grant.user_id,
        agent__owner_id=grant.user_id, agent__definition_id=grant.definition_id)
    if require_active:
        query = query.filter(status="active", agent__status="active")
    session = query.first()
    if session is None:
        raise DelegationRejected("session_not_found", 404)
    return session


def require_request_delegation(request, scope, *, workspace_id=None, agent_id=None, session_id=None,
                               additional_scopes=(), lock=False, require_active=True):
    grant = getattr(request, "app_delegation", None)
    if grant is None:
        return None
    grant = require_current_delegation(grant.id, scope, lock=lock)
    for required_scope in additional_scopes:
        if required_scope not in SCOPES:
            raise ValueError("unknown delegation scope")
        if required_scope not in grant.scopes:
            raise DelegationRejected("delegation_scope_forbidden")
    if workspace_id is not None and workspace_id != grant.workspace_id:
        raise DelegationRejected("workspace_not_found", 404)
    if agent_id is not None:
        require_delegated_agent(grant, agent_id, require_active=require_active)
    if session_id is not None and session_id != "new":
        require_delegated_session(grant, session_id, require_active=require_active)
    request.app_delegation = grant
    return grant


def authorize_delegated_request(request, grant):
    values = request.resolver_match.kwargs
    if "workspace_id" in values and values["workspace_id"] != grant.workspace_id:
        raise DelegationRejected("workspace_not_found", 404)
    if "definition_id" in values and values["definition_id"] != grant.definition_id:
        raise DelegationRejected("agent_definition_not_found", 404)
    if "agent_id" in values:
        require_delegated_agent(grant, values["agent_id"])
    if "session_id" in values:
        if values["session_id"] == "new":
            if "sessions:create" not in grant.scopes:
                raise DelegationRejected("delegation_scope_forbidden")
        else:
            # Message retries must reach their existing receipt before checking
            # lifecycle state. Ownership and assistant binding still apply.
            message_submission = request.method == "POST" and request.resolver_match.url_name == "create_session_message"
            require_delegated_session(grant, values["session_id"], require_active=not message_submission)
        if "agent_run_id" in values and not AgentRun.objects.filter(id=values["agent_run_id"],
            session_id=values["session_id"], user_id=grant.user_id, workspace_id=grant.workspace_id).exists():
            raise DelegationRejected("agent_run_not_found", 404)
    if "operation_id" in values:
        receipt = HostedOperationReceipt.objects.filter(user_id=grant.user_id, workspace_id=grant.workspace_id,
            command=values["command"], operationId=values["operation_id"]).first()
        if receipt is None:
            raise DelegationRejected("operation_not_found", 404)
        require_delegated_session(grant, receipt.sessionId, require_active=False)
    if "artifact_id" in values:
        session_id = Artifact.objects.filter(id=values["artifact_id"], createdBy_id=grant.user_id).values_list("session_id", flat=True).first()
        if session_id is None:
            raise DelegationRejected("artifact_not_found", 404)
        require_delegated_session(grant, session_id)
    if "citation_id" in values:
        session_id = SessionCitationProjection.objects.filter(citationId=values["citation_id"],
            agent_run__user_id=grant.user_id).values_list("session_id", flat=True).first()
        if session_id is None:
            raise DelegationRejected("citation_not_found", 404)
        require_delegated_session(grant, session_id)
    for path_field, object_field, owner_kind in [("library_object_id", "userLibraryObject_id", "userLibraryObject"),
                                                ("source_object_id", "sourceObject_id", "sourceObject")]:
        if path_field not in values:
            continue
        scope = dict(session__workspace_id=grant.workspace_id, session__owner_id=grant.user_id,
                     session__status="active", session__agent__status="active", session__agent__definition_id=grant.definition_id)
        linked = SessionAssetLink.objects.filter(**scope, **{object_field: values[path_field]}).exists()
        cited = SessionCitationProjection.objects.filter(**scope, agent_run__user_id=grant.user_id,
            ownerKind=owner_kind, ownerRef=values[path_field]).exists()
        if not linked and not cited:
            raise DelegationRejected("object_not_found", 404)


def session_authority_is_current(user_id, session_id, delegation_id=None, scope="events:read"):
    user = get_user_model().objects.filter(id=user_id, is_active=True).first()
    session = Session.objects.select_related("agent").filter(id=session_id, owner_id=user_id,
        status="active", agent__owner_id=user_id, agent__status="active").first()
    if user is None or session is None:
        return False
    membership = workspace_membership_for(user, session.workspace_id)
    if membership is None:
        return False
    if session.agent.definition_id and not available_agent_definitions(membership).filter(id=session.agent.definition_id).exists():
        return False
    if delegation_id is not None:
        try:
            grant = require_current_delegation(delegation_id, scope)
            if grant.user_id != user_id:
                return False
            require_delegated_session(grant, session_id)
        except DelegationRejected:
            return False
    return True


def require_run_delegation(run, *, lock=False):
    if run.acting_app_id is None and run.app_delegation_id is None:
        return
    if run.acting_app_id is None or run.app_delegation_id is None:
        raise DelegationRejected("delegation_not_available")
    grant = require_current_delegation(run.app_delegation_id, "messages:submit", lock=lock)
    if grant.app_id != run.acting_app_id or grant.user_id != run.user_id or grant.workspace_id != run.workspace_id:
        raise DelegationRejected("delegation_not_available")
    require_delegated_session(grant, run.session_id)
