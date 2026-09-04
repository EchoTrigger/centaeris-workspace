from django.conf import settings
from ninja import NinjaAPI

from app_core.http.auth import router as auth_router
from app_core.http.agents import router as agents_router
from app_core.http.artifacts import router as artifacts_router
from app_core.http.citations import router as citations_router
from app_core.http.downloads import router as downloads_router
from app_core.http.errors import install_error_handlers
from app_core.http.health import router as health_router
from app_core.http.internal import router as internal_router
from app_core.http.internal_model import router as internal_model_router
from app_core.http.jobs import router as jobs_router
from app_core.http.library import router as library_router
from app_core.http.mcp_credentials import (
    internal_router as internal_mcp_credentials_router,
    router as mcp_credentials_router,
)
from app_core.http.model_management import router as model_management_router
from app_core.http.plugin_lifecycle import router as plugin_lifecycle_router
from app_core.http.sources import router as sources_router
from app_core.http.streaming import router as streaming_router
from app_core.http.trash import router as trash_router
from app_core.http.workspace_members import router as workspace_members_router
from app_core.http.workspaces import router as workspaces_router


api = NinjaAPI(
    title="Centaeris Workspace Agent API",
    version="1.0.0",
    docs_url="/docs" if settings.DEBUG else None,
    openapi_url="/openapi.json" if settings.DEBUG else None,
    urls_namespace="workspace_agent_api",
)
install_error_handlers(api)
api.add_router("", health_router)
api.add_router("/api", auth_router)
api.add_router("/api", agents_router)
api.add_router("/api", jobs_router)
api.add_router("/api", workspaces_router)
api.add_router("/api", workspace_members_router)
api.add_router("/api", citations_router)
api.add_router("/api", sources_router)
api.add_router("/api", library_router)
api.add_router("/api", mcp_credentials_router)
api.add_router("/api", model_management_router)
api.add_router("/api", plugin_lifecycle_router)
api.add_router("/api", artifacts_router)
api.add_router("/api", downloads_router)
api.add_router("/api", streaming_router)
api.add_router("/api", trash_router)
api.add_router("/internal", internal_router)
api.add_router("/internal", internal_model_router)
api.add_router("/internal", internal_mcp_credentials_router)
