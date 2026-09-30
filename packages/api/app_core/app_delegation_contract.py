"""Hosted app delegation identities and operation scopes; no caller-owned claims."""

ISSUER = "centaeris-workspace"
AUDIENCE = "centaeris-workspace-api"
SCOPES = frozenset({"assistant:use", "sessions:read", "sessions:create", "messages:submit",
                    "attachments:write", "events:read", "artifacts:read", "runs:cancel"})


def validate_scopes(value):
    if (not isinstance(value, list) or not value
            or any(not isinstance(scope, str) or scope not in SCOPES for scope in value)
            or len(set(value)) != len(value)):
        raise ValueError("delegation_request_invalid")
    return sorted(value)
