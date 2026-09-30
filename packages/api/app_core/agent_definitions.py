"""Hosted shared configuration; Agent and Session identities remain user-owned."""

from django.db.models import Q

from .models import AgentDefinition


class AgentDefinitionUnavailable(Exception):
    pass


def available_agent_definitions(membership):
    return AgentDefinition.objects.filter(
        workspace_id=membership.workspace_id,
        status="active",
        published_version__isnull=False,
    ).filter(
        Q(availability_scope="workspace")
        | Q(availability_scope="members", member_grants__membership=membership)
    ).select_related("published_version").distinct()


def published_version_for_agent(agent, membership):
    """Preflight availability, then recheck under the Run acceptance locks."""
    if agent.definition_id is None:
        return None
    definition = available_agent_definitions(membership).filter(id=agent.definition_id).first()
    if definition is None:
        raise AgentDefinitionUnavailable("agent_definition_not_available")
    return definition.published_version
