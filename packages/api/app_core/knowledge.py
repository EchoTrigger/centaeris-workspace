import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime

from django.core.files import File
from django.core.files.storage import default_storage
from django.db import transaction
from django.utils.dateparse import parse_datetime

from .assets import DeferredInputResolutionError, delete_stored_object, register_derived_resource
from .deferred_input import DeferredInputBindingError, resolved_input_storage
from .models import (
    Artifact,
    DerivedRepresentation,
    KnowledgeSegment,
    ProcessingSpecification,
    SessionAssetLink,
    AgentRun,
    SourceObject,
    UserLibraryObject,
)
from .runtime_contract import authorization_digest, require_sha256, validate_agent_run_authorization_payload
from .workspace_access import agent_run_membership_is_current


DET_MODEL = "PP-OCRv6_small_det"
REC_MODEL = "PP-OCRv6_small_rec"
MAX_METADATA_BYTES = 64 * 1024 * 1024
MAX_OUTPUT_BYTES = 256 * 1024 * 1024
MAX_READ_BYTES = 50 * 1024
MAX_READ_LINES = 2_000
MAX_SEGMENT_BYTES = 32 * 1024
MAX_SEARCH_SNIPPET_BYTES = 8 * 1024
MAX_SEARCH_CANDIDATES = 10_000


class KnowledgeError(RuntimeError):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class BoundInput:
    resolved: dict
    storage_key: str
    owner: object
    input_identity: dict
    representation_id: str


def canonical_json(value) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def processing_spec_digest(specification: dict) -> str:
    _validate_processing_specification(specification)
    return sha256_bytes(canonical_json(specification))


def representation_id(input_identity: dict, spec_digest: str) -> str:
    _validate_input_identity(input_identity)
    require_sha256("specDigest", spec_digest)
    digest = sha256_bytes(
        canonical_json(
            {"inputIdentity": input_identity, "specDigest": spec_digest}
        )
    ).removeprefix("sha256:")
    return f"representation:sha256:{digest}"


def knowledge_process_job_id(representation_id: str) -> str:
    digest = representation_id.removeprefix("representation:sha256:")
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise KnowledgeError("knowledge_representation_id_invalid", 400)
    return f"knowledge.process:{digest}"


def read_knowledge(body: dict) -> dict:
    agent_run, specification, spec_digest = _bound_knowledge_request(body, "knowledge.read.v1")
    if set(body) != {
        "schema",
        "agentRunId",
        "authorizationDigest",
        "processingSpecification",
        "specDigest",
        "inputs",
        "offset",
        "limit",
    }:
        raise KnowledgeError("knowledge_read_fields_invalid", 400)
    inputs = _bound_inputs(agent_run, body["authorizationDigest"], body["inputs"], spec_digest)
    if not 1 <= len(inputs) <= 4:
        raise KnowledgeError("knowledge_read_inputs_invalid", 400)
    offset = body["offset"]
    limit = body["limit"]
    if len(inputs) > 1 and (offset is not None or limit is not None):
        raise KnowledgeError("knowledge_read_batch_pagination_invalid", 400)
    if offset is not None and (isinstance(offset, bool) or not isinstance(offset, int) or offset < 0):
        raise KnowledgeError("knowledge_read_offset_invalid", 400)
    if limit is not None and (
        isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_READ_LINES
    ):
        raise KnowledgeError("knowledge_read_limit_invalid", 400)
    representations, missing = _representations(inputs)
    if missing:
        return _pending_response("knowledge.read.result.v1", missing)
    items = [
        _read_representation(item, representation, offset or 0, limit or MAX_READ_LINES)
        for item, representation in zip(inputs, representations, strict=True)
    ]
    return {
        "schema": "knowledge.read.result.v1",
        "disposition": "ready",
        "items": items,
        "processingSpecification": specification,
    }


def search_knowledge(body: dict) -> dict:
    agent_run, specification, spec_digest = _bound_knowledge_request(body, "knowledge.search.v1")
    if set(body) != {
        "schema",
        "agentRunId",
        "authorizationDigest",
        "processingSpecification",
        "specDigest",
        "inputs",
        "query",
        "ranking",
        "dateRange",
        "limit",
    }:
        raise KnowledgeError("knowledge_search_fields_invalid", 400)
    query = body["query"]
    ranking = body["ranking"]
    limit = body["limit"]
    if (
        not isinstance(query, str)
        or not query.strip()
        or len(query.encode("utf-8")) > 2_048
        or ranking not in {"relevance", "recent"}
        or isinstance(limit, bool)
        or not isinstance(limit, int)
        or not 1 <= limit <= 20
    ):
        raise KnowledgeError("knowledge_search_arguments_invalid", 400)
    inputs = _bound_inputs(agent_run, body["authorizationDigest"], body["inputs"], spec_digest)
    if len(inputs) > 128:
        raise KnowledgeError("knowledge_search_inputs_invalid", 400)
    date_range = _date_range(body["dateRange"])
    inputs = [
        item
        for item in inputs
        if _within_date_range(_owner_updated_at(item.owner), date_range)
    ]
    representations, missing = _representations(inputs)
    if missing:
        return _pending_response("knowledge.search.result.v1", missing)
    representation_ids = [item.representation_id for item in inputs]
    candidates = list(
        KnowledgeSegment.objects.filter(representation_id__in=representation_ids)
        .select_related("representation")
        .order_by("representation_id", "ordinal")[: MAX_SEARCH_CANDIDATES + 1]
    )
    if len(candidates) > MAX_SEARCH_CANDIDATES:
        raise KnowledgeError("knowledge_search_candidate_limit_exceeded")
    inputs_by_representation = {item.representation_id: item for item in inputs}
    terms = list(dict.fromkeys(re.findall(r"\w+", query.casefold()))) or [query.casefold()]
    matches = []
    for segment in candidates:
        folded = segment.boundedText.casefold()
        score = sum(folded.count(term) for term in terms)
        if not score:
            continue
        item = inputs_by_representation[segment.representation_id]
        if query.casefold() in folded:
            score += 2
        matches.append((score, _owner_updated_at(item.owner), segment, item))
    if ranking == "recent":
        matches.sort(key=lambda value: (-value[1].timestamp(), -value[0], value[2].segmentId))
    else:
        matches.sort(key=lambda value: (-value[0], -value[1].timestamp(), value[2].segmentId))
    hits = [
        _search_hit(segment, item, score)
        for score, _updated, segment, item in matches[:limit]
    ]
    return {
        "schema": "knowledge.search.result.v1",
        "disposition": "ready",
        "query": query,
        "ranking": ranking,
        "hits": hits,
        "processingSpecification": specification,
    }


def commit_knowledge(request) -> dict:
    metadata = _decode_commit_body(request)
    agent_run, specification, spec_digest = _bound_knowledge_request(
        metadata, "knowledge.processing.commit.v1"
    )
    bound = _bound_inputs(
        agent_run,
        metadata["authorizationDigest"],
        [{"inputRef": metadata["inputRef"], "representationId": metadata["representationId"]}],
        spec_digest,
    )[0]
    expected_job_id = knowledge_process_job_id(bound.representation_id)
    if metadata["jobId"] != expected_job_id:
        raise KnowledgeError("knowledge_job_binding_mismatch")
    existing = DerivedRepresentation.objects.filter(
        representationId=bound.representation_id
    ).first()
    canonical_key = _canonical_key(bound.representation_id)
    preview_key = _preview_key(bound.representation_id) if metadata["previewSizeBytes"] else ""
    created = []
    try:
        canonical_created = _store_stream(
            request,
            canonical_key,
            metadata["canonicalSizeBytes"],
            metadata["canonicalSha256"],
        )
        if canonical_created:
            created.append(canonical_key)
        if preview_key:
            preview_created = _store_stream(
                request,
                preview_key,
                metadata["previewSizeBytes"],
                metadata["previewSha256"],
            )
            if preview_created:
                created.append(preview_key)
        if request.read(1):
            raise KnowledgeError("knowledge_commit_body_has_trailing_bytes", 400)
        canonical = _read_stored(
            canonical_key,
            metadata["canonicalSizeBytes"],
            metadata["canonicalSha256"],
        )
        manifest = metadata["manifest"]
        _validate_manifest(manifest, canonical)
        if existing is not None:
            _require_existing_representation(existing, bound, metadata, canonical_key, preview_key)
            return _commit_response(existing)
        segments = _segments(bound.representation_id, manifest)
        with transaction.atomic():
            stored_spec, inserted = ProcessingSpecification.objects.get_or_create(
                specDigest=spec_digest, defaults={"payload": specification}
            )
            if not inserted and stored_spec.payload != specification:
                raise KnowledgeError("knowledge_specification_identity_conflict")
            representation = DerivedRepresentation.objects.create(
                representationId=bound.representation_id,
                ownerKind=bound.input_identity["ownerKind"],
                ownerId=bound.input_identity["ownerId"],
                ownerContentGeneration=bound.input_identity["generation"],
                ownerSha256=bound.input_identity["sha256"],
                processingSpecification=stored_spec,
                pageCount=manifest["pageCount"],
                canonicalTextKey=canonical_key,
                canonicalTextSizeBytes=metadata["canonicalSizeBytes"],
                canonicalTextSha256=metadata["canonicalSha256"],
                previewPdfKey=preview_key,
                previewPdfSizeBytes=metadata["previewSizeBytes"],
                previewPdfSha256=metadata["previewSha256"] or "",
                manifest=manifest,
            )
            KnowledgeSegment.objects.bulk_create(
                [KnowledgeSegment(representation=representation, **segment) for segment in segments]
            )
            register_derived_resource(bound.owner, "storageObject", canonical_key)
            if preview_key:
                register_derived_resource(bound.owner, "storageObject", preview_key)
        return _commit_response(representation)
    except Exception:
        for storage_key in created:
            delete_stored_object(storage_key)
        raise


def _bound_knowledge_request(body: dict, schema: str):
    if not isinstance(body, dict) or body.get("schema") != schema:
        raise KnowledgeError("knowledge_request_schema_invalid", 400)
    try:
        agent_run = AgentRun.objects.select_related("authorization", "user").get(id=body["agentRunId"])
    except (KeyError, AgentRun.DoesNotExist) as error:
        raise KnowledgeError("knowledge_agent_run_not_found", 404) from error
    if not agent_run_membership_is_current(agent_run):
        raise KnowledgeError("knowledge_authorization_mismatch", 403)
    authorization = agent_run.authorization
    validate_agent_run_authorization_payload(authorization.payload)
    if (
        authorization_digest(authorization.payload) != authorization.digest
        or body.get("authorizationDigest") != authorization.digest
    ):
        raise KnowledgeError("knowledge_authorization_mismatch", 403)
    specification = body.get("processingSpecification")
    spec_digest = processing_spec_digest(specification)
    if body.get("specDigest") != spec_digest:
        raise KnowledgeError("knowledge_specification_digest_mismatch")
    return agent_run, specification, spec_digest


def _bound_inputs(agent_run, digest: str, requests: list, spec_digest: str) -> list[BoundInput]:
    if not isinstance(requests, list):
        raise KnowledgeError("knowledge_inputs_invalid", 400)
    input_refs = []
    for request in requests:
        if (
            not isinstance(request, dict)
            or set(request) != {"inputRef", "representationId"}
            or not isinstance(request["inputRef"], str)
            or not request["inputRef"].strip()
        ):
            raise KnowledgeError("knowledge_input_fields_invalid", 400)
        input_refs.append(request["inputRef"])
    if len(set(input_refs)) != len(input_refs):
        raise KnowledgeError("knowledge_inputs_invalid", 400)
    declared_by_ref = {
        item["inputRef"]: item for item in agent_run.authorization.payload["assetRefs"]
    }
    bound = []
    for request in requests:
        declared = declared_by_ref.get(request["inputRef"])
        if declared is None:
            raise KnowledgeError("knowledge_input_not_authorized", 403)
        identity = declared["inputIdentity"]
        expected = representation_id(identity, spec_digest)
        if request["representationId"] != expected:
            raise KnowledgeError("knowledge_representation_binding_mismatch")
        try:
            resolved, storage_key = resolved_input_storage(agent_run, request["inputRef"], digest)
        except DeferredInputResolutionError as error:
            raise KnowledgeError(error.errorCode) from error
        except DeferredInputBindingError as error:
            raise KnowledgeError("knowledge_input_binding_invalid") from error
        owner = _input_owner(agent_run, request["inputRef"], resolved)
        bound.append(BoundInput(resolved, storage_key, owner, identity, expected))
    return bound


def _input_owner(agent_run, input_ref: str, resolved: dict):
    try:
        link = SessionAssetLink.objects.select_related(
            "sourceObject", "userLibraryObject", "artifact"
        ).get(id=input_ref, session=agent_run.session, workspace=agent_run.workspace)
    except SessionAssetLink.DoesNotExist as error:
        raise KnowledgeError("knowledge_input_not_authorized", 403) from error
    owner = link.sourceObject or link.userLibraryObject or link.artifact
    if owner is None or owner.id != resolved["objectRef"]:
        raise KnowledgeError("knowledge_input_binding_invalid")
    return owner


def _representations(inputs: list[BoundInput]):
    by_id = DerivedRepresentation.objects.in_bulk(
        [item.representation_id for item in inputs], field_name="representationId"
    )
    representations = []
    missing = []
    for item in inputs:
        representation = by_id.get(item.representation_id)
        if representation is None:
            missing.append(
                {"inputRef": item.resolved["inputRef"], "representationId": item.representation_id}
            )
        else:
            _require_representation_input(representation, item)
        representations.append(representation)
    return representations, missing


def _pending_response(schema: str, missing: list) -> dict:
    return {"schema": schema, "disposition": "pending", "missing": missing}


def _read_representation(bound: BoundInput, representation, offset: int, limit: int) -> dict:
    content = _read_stored(
        representation.canonicalTextKey,
        representation.canonicalTextSizeBytes,
        representation.canonicalTextSha256,
    ).decode("utf-8", errors="strict")
    lines = content.splitlines()
    if offset > len(lines):
        raise KnowledgeError("knowledge_read_offset_exceeds_content", 400)
    selected = []
    output_bytes = 0
    truncated_by = None
    first_line_exceeds_limit = False
    for line in lines[offset:]:
        if len(selected) == limit:
            truncated_by = "lines"
            break
        encoded = line.encode("utf-8")
        next_bytes = output_bytes + (1 if selected else 0) + len(encoded)
        if next_bytes > MAX_READ_BYTES:
            truncated_by = "bytes"
            first_line_exceeds_limit = not selected
            break
        selected.append(line)
        output_bytes = next_bytes
    end_offset = offset + len(selected)
    truncated = end_offset < len(lines)
    if not truncated:
        truncated_by = None
        first_line_exceeds_limit = False
    selected_text = "\n".join(selected)
    locator = _line_locator(content, offset + 1, end_offset) if selected_text else None
    page_start, page_end = _locator_pages(representation.manifest, locator) if locator else (None, None)
    if locator is not None:
        locator["pageStart"] = page_start
        locator["pageEnd"] = page_end
    return {
        "schema": "file_read_result.v1",
        "path": bound.resolved["virtualPath"],
        "startLine": offset + 1,
        "endLine": end_offset,
        "totalLines": len(lines),
        "totalBytes": len(content.encode("utf-8")),
        "outputBytes": output_bytes,
        "maxLines": limit,
        "maxBytes": MAX_READ_BYTES,
        "truncated": truncated,
        "truncatedBy": truncated_by,
        "firstLineExceedsLimit": first_line_exceeds_limit,
        "nextOffset": end_offset if truncated and not first_line_exceeds_limit else None,
        "fileHash": representation.canonicalTextSha256,
        "content": selected_text,
        "inputRef": bound.resolved["inputRef"],
        "displayName": bound.resolved["displayName"],
        "ownerRef": bound.resolved["objectRef"],
        "ownerKind": bound.resolved["ownerKind"],
        "evidenceKind": bound.resolved["evidenceKind"],
        "ownerSha256": bound.resolved["sha256"],
        "ownerGeneration": bound.input_identity["generation"],
        "representationId": representation.representationId,
        "specDigest": representation.processingSpecification_id,
        "locator": locator,
        "evidenceSha256": sha256_bytes(selected_text.encode("utf-8")),
        "citationAllowed": bound.resolved["citationAllowed"] and bool(selected_text),
        "pageStart": page_start,
        "pageEnd": page_end,
        "documentRoute": "knowledgeDerived",
        "documentUsedOcr": any(
            page["pageText"]["route"] == "ppOcrV6Small"
            for page in representation.manifest["pages"]
        ),
    }


def _search_hit(segment, bound: BoundInput, score: int) -> dict:
    content = _bounded_utf8_prefix(segment.boundedText, MAX_SEARCH_SNIPPET_BYTES)
    locator = dict(segment.locator)
    locator["endByte"] = locator["startByte"] + len(content.encode("utf-8"))
    locator["endLine"] = locator["startLine"] + content.count("\n")
    return {
        "segmentId": segment.segmentId,
        "inputRef": bound.resolved["inputRef"],
        "displayName": bound.resolved["displayName"],
        "ownerRef": bound.resolved["objectRef"],
        "ownerKind": bound.resolved["ownerKind"],
        "evidenceKind": bound.resolved["evidenceKind"],
        "ownerSha256": bound.resolved["sha256"],
        "ownerGeneration": bound.input_identity["generation"],
        "representationId": segment.representation_id,
        "specDigest": segment.representation.processingSpecification_id,
        "locator": locator,
        "evidenceSha256": sha256_bytes(content.encode("utf-8")),
        "citationAllowed": bound.resolved["citationAllowed"],
        "score": score,
        "content": content,
        "updatedAt": _owner_updated_at(bound.owner).isoformat(),
    }


def _decode_commit_body(request) -> dict:
    try:
        content_length = int(request.META.get("CONTENT_LENGTH"))
    except (TypeError, ValueError) as error:
        raise KnowledgeError("knowledge_commit_content_length_invalid", 400) from error
    metadata_length = int.from_bytes(_read_exact(request, 4), "big")
    if not 0 < metadata_length <= MAX_METADATA_BYTES:
        raise KnowledgeError("knowledge_commit_metadata_length_invalid", 400)
    try:
        metadata = json.loads(_read_exact(request, metadata_length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise KnowledgeError("knowledge_commit_metadata_invalid", 400) from error
    fields = {
        "schema", "jobId", "agentRunId", "authorizationDigest", "inputRef",
        "representationId", "processingSpecification", "specDigest", "canonicalSizeBytes",
        "canonicalSha256", "previewSizeBytes", "previewSha256", "manifest",
    }
    if not isinstance(metadata, dict) or set(metadata) != fields:
        raise KnowledgeError("knowledge_commit_fields_invalid", 400)
    for name in ["canonicalSizeBytes", "previewSizeBytes"]:
        value = metadata[name]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise KnowledgeError("knowledge_commit_size_invalid", 400)
    if (
        metadata["canonicalSizeBytes"] <= 0
        or metadata["canonicalSizeBytes"] + metadata["previewSizeBytes"] > MAX_OUTPUT_BYTES
    ):
        raise KnowledgeError("knowledge_commit_size_invalid", 400)
    require_sha256("canonicalSha256", metadata["canonicalSha256"])
    if metadata["previewSizeBytes"]:
        require_sha256("previewSha256", metadata["previewSha256"])
    elif metadata["previewSha256"] is not None:
        raise KnowledgeError("knowledge_commit_preview_identity_invalid", 400)
    if content_length != 4 + metadata_length + metadata["canonicalSizeBytes"] + metadata["previewSizeBytes"]:
        raise KnowledgeError("knowledge_commit_content_length_mismatch", 400)
    return metadata


def _store_stream(request, storage_key: str, size_bytes: int, expected_hash: str) -> bool:
    if default_storage.exists(storage_key):
        _validate_stored(storage_key, size_bytes, expected_hash)
        _discard_exact(request, size_bytes, expected_hash)
        return False
    reader = _HashingReader(request, size_bytes)
    stored_key = default_storage.save(storage_key, File(reader, name=storage_key.rsplit("/", 1)[-1]))
    if stored_key != storage_key:
        delete_stored_object(stored_key)
        raise KnowledgeError("knowledge_storage_key_conflict")
    reader.require_complete(expected_hash)
    _validate_stored(storage_key, size_bytes, expected_hash)
    return True


def _validate_stored(storage_key: str, size_bytes: int, expected_hash: str) -> None:
    if not default_storage.exists(storage_key):
        raise KnowledgeError("knowledge_storage_missing")
    digest = hashlib.sha256()
    actual_size = 0
    with default_storage.open(storage_key, "rb") as source:
        while chunk := source.read(1024 * 1024):
            actual_size += len(chunk)
            if actual_size > size_bytes:
                raise KnowledgeError("knowledge_storage_integrity_mismatch")
            digest.update(chunk)
    if actual_size != size_bytes or f"sha256:{digest.hexdigest()}" != expected_hash:
        raise KnowledgeError("knowledge_storage_integrity_mismatch")


def _read_stored(storage_key: str, size_bytes: int, expected_hash: str) -> bytes:
    if not default_storage.exists(storage_key):
        raise KnowledgeError("knowledge_storage_missing")
    with default_storage.open(storage_key, "rb") as source:
        content = source.read(size_bytes + 1)
    if len(content) != size_bytes or sha256_bytes(content) != expected_hash:
        raise KnowledgeError("knowledge_storage_integrity_mismatch")
    return content


class _HashingReader:
    def __init__(self, source, size_bytes: int):
        self.source = source
        self.remaining = size_bytes
        self.digest = hashlib.sha256()

    def read(self, size: int = -1) -> bytes:
        if not self.remaining:
            return b""
        requested = self.remaining if size is None or size < 0 else min(size, self.remaining)
        chunk = self.source.read(requested)
        if not chunk:
            raise KnowledgeError("knowledge_commit_body_truncated", 400)
        self.remaining -= len(chunk)
        self.digest.update(chunk)
        return chunk

    def require_complete(self, expected_hash: str):
        if self.remaining or f"sha256:{self.digest.hexdigest()}" != expected_hash:
            raise KnowledgeError("knowledge_commit_integrity_mismatch")


def _discard_exact(request, size_bytes: int, expected_hash: str):
    reader = _HashingReader(request, size_bytes)
    while reader.read(64 * 1024):
        pass
    reader.require_complete(expected_hash)


def _read_exact(request, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining:
        chunk = request.read(remaining)
        if not chunk:
            raise KnowledgeError("knowledge_commit_body_truncated", 400)
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _segments(representation_id: str, manifest: dict) -> list[dict]:
    segments = []
    ordinal = 0
    for page in manifest["pages"]:
        text = page["pageText"]["text"]
        encoded = text.encode("utf-8")
        start = 0
        line = page["canonicalStartLine"]
        while start < len(encoded):
            end = min(len(encoded), start + MAX_SEGMENT_BYTES)
            while end > start:
                try:
                    bounded = encoded[start:end].decode("utf-8")
                    break
                except UnicodeDecodeError:
                    end -= 1
            if end == start:
                raise KnowledgeError("knowledge_segment_utf8_boundary_invalid")
            if bounded.strip():
                text_hash = sha256_bytes(bounded.encode("utf-8"))
                identity = sha256_bytes(
                    canonical_json([representation_id, ordinal, text_hash])
                ).removeprefix("sha256:")
                segments.append(
                    {
                        "segmentId": f"segment:sha256:{identity}",
                        "ordinal": ordinal,
                        "boundedText": bounded,
                        "textSha256": text_hash,
                        "locator": {
                            "kind": "textSpan",
                            "pageStart": page["pageText"]["page"],
                            "pageEnd": page["pageText"]["page"],
                            "startByte": page["canonicalStartByte"] + start,
                            "endByte": page["canonicalStartByte"] + end,
                            "startLine": line,
                            "endLine": line + bounded.count("\n"),
                        },
                    }
                )
                ordinal += 1
            line += bounded.count("\n")
            start = end
    return segments


def _line_locator(content: str, start_line: int, end_line: int) -> dict:
    if end_line < start_line:
        raise KnowledgeError("knowledge_read_locator_invalid")
    lines = content.splitlines(keepends=True)
    start_byte = len("".join(lines[: start_line - 1]).encode("utf-8"))
    end_byte = len("".join(lines[:end_line]).encode("utf-8"))
    return {
        "kind": "textSpan", "pageStart": None, "pageEnd": None, "startByte": start_byte,
        "endByte": max(start_byte + 1, end_byte), "startLine": start_line, "endLine": end_line,
    }


def _bounded_utf8_prefix(value: str, maximum_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum_bytes:
        return value
    end = maximum_bytes
    while end and encoded[end : end + 1] and encoded[end] & 0b1100_0000 == 0b1000_0000:
        end -= 1
    return encoded[:end].decode("utf-8")


def _locator_pages(manifest: dict, locator: dict):
    pages = [
        page["pageText"]["page"]
        for page in manifest["pages"]
        if page["canonicalStartByte"] < locator["endByte"]
        and page["canonicalEndByte"] > locator["startByte"]
    ]
    return (min(pages), max(pages)) if pages else (None, None)


def _validate_processing_specification(value: dict):
    fields = {"schema", "processorId", "processorVersion", "executionImageDigest", "modelDigests", "options"}
    if not isinstance(value, dict) or set(value) != fields or value["schema"] != "knowledge.processing_specification.v1":
        raise KnowledgeError("knowledge_specification_invalid", 400)
    if value["processorId"] not in {"centaeris.document.cpu", "centaeris.document.cuda.gpu0"} or value["processorVersion"] != "1.0.0":
        raise KnowledgeError("knowledge_processor_identity_unsupported", 400)
    require_sha256("executionImageDigest", value["executionImageDigest"])
    if not isinstance(value["modelDigests"], dict) or set(value["modelDigests"]) != {DET_MODEL, REC_MODEL}:
        raise KnowledgeError("knowledge_model_identity_invalid", 400)
    for digest in value["modelDigests"].values():
        require_sha256("modelDigest", digest)
    expected_options = {
        "renderDpi": 220, "maxInputBytes": 64 * 1024 * 1024,
        "maxRenderedPixelsPerPage": 16_000_000, "maxOutputBytes": MAX_OUTPUT_BYTES,
    }
    if value["options"] != expected_options:
        raise KnowledgeError("knowledge_processing_options_unsupported", 400)


def _validate_input_identity(value: dict):
    if not isinstance(value, dict) or set(value) != {"ownerKind", "ownerId", "generation", "sha256"}:
        raise KnowledgeError("knowledge_input_identity_invalid", 400)
    if value["ownerKind"] not in {"sourceObject", "userLibraryObject", "artifact"}:
        raise KnowledgeError("knowledge_owner_kind_unsupported", 400)
    if not isinstance(value["ownerId"], str) or not value["ownerId"]:
        raise KnowledgeError("knowledge_input_identity_invalid", 400)
    if isinstance(value["generation"], bool) or not isinstance(value["generation"], int) or value["generation"] < 0:
        raise KnowledgeError("knowledge_input_identity_invalid", 400)
    require_sha256("inputIdentity.sha256", value["sha256"])


def _validate_manifest(manifest: dict, canonical: bytes):
    try:
        canonical.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise KnowledgeError("knowledge_canonical_utf8_invalid", 400) from error
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schema", "pageCount", "pages"}
        or manifest.get("schema") != "knowledge.derived_manifest.v1"
    ):
        raise KnowledgeError("knowledge_manifest_invalid", 400)
    pages = manifest["pages"]
    if (
        not isinstance(pages, list)
        or isinstance(manifest["pageCount"], bool)
        or not isinstance(manifest["pageCount"], int)
        or manifest["pageCount"] != len(pages)
        or not pages
    ):
        raise KnowledgeError("knowledge_manifest_page_count_invalid", 400)
    previous_end = 0
    previous_end_line = 1
    for expected_page, page in enumerate(pages, 1):
        if not isinstance(page, dict) or set(page) != {
            "pageText", "canonicalStartByte", "canonicalEndByte",
            "canonicalStartLine", "canonicalEndLine",
        }:
            raise KnowledgeError("knowledge_manifest_page_invalid", 400)
        text = page["pageText"]
        if not isinstance(text, dict) or set(text) != {
            "schema", "page", "route", "widthMillipoints", "heightMillipoints",
            "text", "textSha256", "spans",
        }:
            raise KnowledgeError("knowledge_page_text_invalid", 400)
        encoded = text["text"].encode("utf-8") if isinstance(text["text"], str) else b""
        positions = [
            page["canonicalStartByte"], page["canonicalEndByte"],
            page["canonicalStartLine"], page["canonicalEndLine"],
        ]
        if (
            any(isinstance(value, bool) or not isinstance(value, int) for value in positions)
            or text["schema"] != "knowledge.page_text.v1"
            or isinstance(text["page"], bool)
            or not isinstance(text["page"], int)
            or text["page"] != expected_page
            or text["route"] not in {"nativeText", "pdfNative", "ppOcrV6Small", "empty"}
            or not _positive_int(text["widthMillipoints"], 4_294_967_295)
            or not _positive_int(text["heightMillipoints"], 4_294_967_295)
            or len(encoded) > 4 * 1024 * 1024
            or sha256_bytes(encoded) != text["textSha256"]
            or page["canonicalStartByte"] < previous_end
            or page["canonicalStartByte"] < 0
            or page["canonicalEndByte"] != page["canonicalStartByte"] + len(encoded)
            or page["canonicalEndByte"] > len(canonical)
            or canonical[page["canonicalStartByte"] : page["canonicalEndByte"]] != encoded
            or page["canonicalStartLine"] != previous_end_line + canonical.count(b"\n", previous_end, page["canonicalStartByte"])
            or page["canonicalEndLine"] != page["canonicalStartLine"] + encoded.count(b"\n")
        ):
            raise KnowledgeError("knowledge_page_text_identity_invalid", 400)
        spans = text["spans"]
        if (
            not isinstance(spans, list)
            or len(spans) > 200_000
            or any(not _valid_page_text_span(span) for span in spans)
            or (text["route"] == "empty" and (encoded or spans))
            or (spans and "\n".join(span["text"] for span in spans) != text["text"])
            or (encoded and not spans)
        ):
            raise KnowledgeError("knowledge_page_text_spans_invalid", 400)
        previous_end = page["canonicalEndByte"]
        previous_end_line = page["canonicalEndLine"]


def _positive_int(value, maximum: int) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 < value <= maximum
    )


def _valid_page_text_span(span) -> bool:
    if not isinstance(span, dict) or set(span) not in [
        {"text", "bbox"},
        {"text", "bbox", "confidenceMilli"},
    ]:
        return False
    bbox = span["bbox"]
    confidence = span.get("confidenceMilli")
    return (
        isinstance(span["text"], str)
        and bool(span["text"])
        and isinstance(bbox, list)
        and len(bbox) == 4
        and all(isinstance(value, int) and not isinstance(value, bool) for value in bbox)
        and 0 <= bbox[0] < bbox[2] <= 10_000
        and 0 <= bbox[1] < bbox[3] <= 10_000
        and (
            confidence is None
            or isinstance(confidence, int)
            and not isinstance(confidence, bool)
            and 0 <= confidence <= 1_000
        )
    )


def _require_representation_input(representation, bound: BoundInput):
    if (
        representation.ownerKind != bound.input_identity["ownerKind"]
        or representation.ownerId != bound.input_identity["ownerId"]
        or representation.ownerContentGeneration != bound.input_identity["generation"]
        or representation.ownerSha256 != bound.input_identity["sha256"]
    ):
        raise KnowledgeError("knowledge_representation_identity_conflict")


def _require_existing_representation(existing, bound, metadata, canonical_key, preview_key):
    _require_representation_input(existing, bound)
    if (
        existing.processingSpecification_id != metadata["specDigest"]
        or existing.canonicalTextKey != canonical_key
        or existing.canonicalTextSizeBytes != metadata["canonicalSizeBytes"]
        or existing.canonicalTextSha256 != metadata["canonicalSha256"]
        or existing.previewPdfKey != preview_key
        or existing.previewPdfSizeBytes != metadata["previewSizeBytes"]
        or existing.previewPdfSha256 != (metadata["previewSha256"] or "")
        or existing.manifest != metadata["manifest"]
    ):
        raise KnowledgeError("knowledge_representation_identity_conflict")


def _commit_response(representation):
    return {
        "schema": "knowledge.processing.commit.result.v1",
        "representationId": representation.representationId,
        "specDigest": representation.processingSpecification_id,
        "pageCount": representation.pageCount,
    }


def _canonical_key(representation_id: str) -> str:
    return f"knowledge/{representation_id.removeprefix('representation:sha256:')}/canonical.md"


def _preview_key(representation_id: str) -> str:
    return f"knowledge/{representation_id.removeprefix('representation:sha256:')}/preview.pdf"


def _owner_updated_at(owner) -> datetime:
    value = getattr(owner, "updatedAt", None) or getattr(owner, "publishedAt", None) or owner.createdAt
    return value.astimezone(UTC)


def _date_range(value):
    if value is None:
        return None, None
    if not isinstance(value, dict) or set(value) != {"updatedFrom", "updatedTo"}:
        raise KnowledgeError("knowledge_search_date_range_invalid", 400)
    parsed = []
    for name in ("updatedFrom", "updatedTo"):
        raw = value[name]
        date = parse_datetime(raw) if isinstance(raw, str) else None
        if raw is not None and (date is None or date.tzinfo is None):
            raise KnowledgeError("knowledge_search_date_range_invalid", 400)
        parsed.append(date.astimezone(UTC) if date else None)
    if parsed[0] and parsed[1] and parsed[0] > parsed[1]:
        raise KnowledgeError("knowledge_search_date_range_invalid", 400)
    return tuple(parsed)


def _within_date_range(value, date_range):
    lower, upper = date_range
    return (lower is None or value >= lower) and (upper is None or value <= upper)
