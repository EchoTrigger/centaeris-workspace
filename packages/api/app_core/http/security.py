import secrets

from django.conf import settings
from ninja.utils import check_csrf
from ninja.security import APIKeyHeader, SessionAuth


class PublicAuthenticationRequired(RuntimeError):
    pass


class InternalAuthenticationRequired(RuntimeError):
    pass


class PublicCsrfRejected(RuntimeError):
    pass


class SuperuserRequired(RuntimeError):
    pass


class ProductSessionAuth(SessionAuth):
    def __init__(self):
        # Authentication must win over CSRF for anonymous requests. Ninja's
        # SessionAuth checks CSRF before authenticate() by default, so keep the
        # check here where the authenticated principal is already known.
        super().__init__(csrf=False)

    def authenticate(self, request, key):
        if request.user.is_authenticated:
            if request.method not in {"GET", "HEAD", "OPTIONS", "TRACE"}:
                if request.content_type == "application/json":
                    _ = request.body
                if check_csrf(request) is not None:
                    raise PublicCsrfRejected("csrf_failed")
            return request.user
        raise PublicAuthenticationRequired("authentication_required")


class ProductSuperuserAuth(ProductSessionAuth):
    def authenticate(self, request, key):
        user = super().authenticate(request, key)
        if not user.is_superuser:
            raise SuperuserRequired("superuser_required")
        return user


class InternalTokenAuth(APIKeyHeader):
    param_name = "X-Internal-Token"

    def authenticate(self, request, key):
        if isinstance(key, str) and secrets.compare_digest(key, settings.INTERNAL_API_TOKEN):
            return key
        raise InternalAuthenticationRequired("unauthorized")


def require_public_csrf(request):
    """Run CSRF before Ninja parses an unauthenticated mutation body."""
    if check_csrf(request) is not None:
        raise PublicCsrfRejected("csrf_failed")
    return True


session_auth = ProductSessionAuth()
superuser_auth = ProductSuperuserAuth()
internal_token_auth = InternalTokenAuth()
