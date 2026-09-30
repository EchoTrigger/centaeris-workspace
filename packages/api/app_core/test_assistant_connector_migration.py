"""Connector authority starts empty and remains scoped to its approved assistant."""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase
from django.utils import timezone

from .models import (
    AgentConnectorBinding, AgentConnectorCredentialApproval, AgentDefinition,
    McpBearerCredential, Workspace, empty_plugin_activation,
)


class AssistantConnectorMigrationTests(TransactionTestCase):
    serialized_rollback = True

    def test_forward_migration_preserves_private_and_managed_history_without_granting_credentials(self):
        previous = [("app_core", "0007_agent_definitions")]
        target = [("app_core", "0008_assistant_connector_authority")]
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        try:
            executor.migrate(previous)
            apps = executor.loader.project_state(previous).apps
            historical = lambda name: apps.get_model("app_core", name)
            user = apps.get_model("auth", "User").objects.create(username="connector-legacy-owner")
            workspace = historical("Workspace").objects.create(name="Legacy", createdBy=user)
            membership = historical("WorkspaceMembership").objects.create(workspace=workspace, user=user)
            definition = historical("AgentDefinition").objects.create(
                workspace=workspace, created_by=user, name="Business", instructions="managed snapshot")
            version = historical("AgentDefinitionVersion").objects.create(
                definition=definition, version=1, name="Business", instructions="managed snapshot",
                published_by=user)
            definition.published_version = version
            definition.save()
            model = historical("ModelConfig").objects.create(displayName="Synthetic")
            identities = []
            for managed in (False, True):
                instructions = "managed snapshot" if managed else "private snapshot"
                agent = historical("Agent").objects.create(workspace=workspace, owner=user,
                    name="Managed" if managed else "Private", instructions=instructions,
                    definition=definition if managed else None)
                session = historical("Session").objects.create(workspace=workspace, owner=user, agent=agent)
                run = historical("AgentRun").objects.create(workspace=workspace, session=session,
                    user=user, modelConfig=model, membership_ref=membership.id, prompt="synthetic",
                    agent_instructions=instructions, definition_version=version if managed else None)
                identities.append((agent.pk, session.pk, run.pk, instructions, managed))
            credential = historical("McpBearerCredential").objects.create(
                plugin_name="synthetic-plugin", credential_ref="legacy-ref", display_name="Synthetic",
                encrypted_secret="synthetic-opaque-ciphertext", created_by=user, updated_by=user, version=3)
            forward = MigrationExecutor(connection)
            forward.migrate(target)
            migrated = forward.loader.project_state(target).apps
            current = lambda name: migrated.get_model("app_core", name)
            self.assertEqual(current("AgentDefinition").objects.get(pk=definition.pk).plugin_names, [])
            self.assertEqual(current("AgentDefinitionVersion").objects.get(pk=version.pk).plugin_activation,
                             empty_plugin_activation())
            for agent_id, session_id, run_id, instructions, managed in identities:
                with self.subTest(managed=managed):
                    agent = current("Agent").objects.get(pk=agent_id)
                    session = current("Session").objects.get(pk=session_id)
                    run = current("AgentRun").objects.get(pk=run_id)
                    self.assertEqual((agent.workspace_id, agent.owner_id, agent.instructions, agent.definition_id),
                                     (workspace.pk, user.pk, instructions, definition.pk if managed else None))
                    self.assertEqual((session.workspace_id, session.owner_id, session.agent_id),
                                     (workspace.pk, user.pk, agent_id))
                    self.assertEqual((run.workspace_id, run.user_id, run.session_id, run.membership_ref,
                                      run.agent_instructions, run.definition_version_id),
                                     (workspace.pk, user.pk, session_id, membership.pk, instructions,
                                      version.pk if managed else None))
            source = current("McpBearerCredential").objects.get(pk=credential.pk)
            self.assertEqual((source.plugin_name, source.credential_ref, source.encrypted_secret,
                              source.version, source.created_by_id, source.updated_by_id),
                             ("synthetic-plugin", "legacy-ref", "synthetic-opaque-ciphertext", 3, user.pk, user.pk))
            self.assertFalse(current("AgentConnectorCredentialApproval").objects.exists())
            self.assertFalse(current("AgentConnectorBinding").objects.exists())
        finally:
            MigrationExecutor(connection).migrate(latest)


class AssistantConnectorScopeTests(TestCase):
    def setUp(self):
        self.custodian = get_user_model().objects.create_user(username="connector-custodian", is_superuser=True)
        self.admin = get_user_model().objects.create_user(username="connector-admin")
        self.other_custodian = get_user_model().objects.create_user(username="other-custodian", is_superuser=True)
        self.workspace = Workspace.objects.create(name="Business", createdBy=self.admin)
        self.foreign = Workspace.objects.create(name="Foreign", createdBy=self.admin)
        self.definition = AgentDefinition.objects.create(workspace=self.workspace, created_by=self.admin, name="First")
        self.other_definition = AgentDefinition.objects.create(workspace=self.workspace, created_by=self.admin, name="Second")
        self.source = self.make_source("first-source")

    def make_source(self, ref):
        return McpBearerCredential.objects.create(plugin_name="synthetic-plugin", credential_ref=ref,
            display_name="Synthetic", encrypted_secret="synthetic-opaque-ciphertext",
            created_by=self.custodian, updated_by=self.custodian)

    def make_approval(self, **overrides):
        fields = dict(workspace=self.workspace, definition=self.definition, plugin_name="synthetic-plugin",
            server_id="synthetic-server", resource_path="mcp/server.json", resource_digest="sha256:" + "a" * 64,
            credential=self.source, credential_version=self.source.version, approved_by=self.custodian)
        fields.update(overrides)
        return AgentConnectorCredentialApproval.objects.create(**fields)

    def make_binding(self, approval, **overrides):
        fields = dict(workspace=self.workspace, definition=self.definition, plugin_name="synthetic-plugin",
                      server_id="synthetic-server", approval=approval, updated_by=self.admin)
        fields.update(overrides)
        return AgentConnectorBinding.objects.create(**fields)

    def test_only_source_custodian_can_approve_and_scope_and_version_must_match(self):
        for overrides in ({"approved_by": self.admin}, {"approved_by": self.other_custodian},
                          {"workspace": self.foreign}, {"plugin_name": "another-plugin"},
                          {"credential_version": 2}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.make_approval(**overrides)
        self.assertFalse(AgentConnectorCredentialApproval.objects.exists())
        self.assertIsNotNone(self.make_approval().pk)

    def test_approval_cannot_be_retargeted_and_revocation_cannot_be_undone(self):
        approval = self.make_approval()
        alternate = self.make_source("alternate-source")
        for field, value in (("definition", self.other_definition), ("credential", alternate),
                             ("credential_version", 2), ("approved_by", self.other_custodian),
                             ("server_id", "another-server"), ("resource_path", "mcp/other.json"),
                             ("resource_digest", "sha256:" + "b" * 64)):
            with self.subTest(field=field):
                setattr(approval, field, value)
                with self.assertRaises(ValueError):
                    approval.save()
                approval.refresh_from_db()
        approval.revoked_at = timezone.now()
        approval.save(update_fields=["revoked_at"])
        revoked = approval.revoked_at
        for value in (None, revoked + timedelta(seconds=1)):
            approval.revoked_at = value
            with self.assertRaises(ValueError):
                approval.save(update_fields=["revoked_at"])
            approval.refresh_from_db()
            self.assertEqual(approval.revoked_at, revoked)

    def test_binding_rejects_other_assistant_workspace_connector_and_revoked_approval(self):
        approval = self.make_approval()
        for overrides in ({"definition": self.other_definition}, {"workspace": self.foreign},
                          {"plugin_name": "another-plugin"}, {"server_id": "another-server"}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.make_binding(approval, **overrides)
        approval.revoked_at = timezone.now()
        approval.save(update_fields=["revoked_at"])
        with self.assertRaises(ValueError):
            self.make_binding(approval)
        self.assertFalse(AgentConnectorBinding.objects.exists())

    def test_same_plugin_can_bind_distinct_assistant_credentials_without_retargeting_existing_scope(self):
        first_approval = self.make_approval()
        second_source = self.make_source("second-source")
        second_approval = self.make_approval(definition=self.other_definition, credential=second_source)
        first = self.make_binding(first_approval)
        second = self.make_binding(second_approval, definition=self.other_definition)
        self.assertNotEqual(first.approval.credential_id, second.approval.credential_id)
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.make_binding(first_approval)
        first.definition = self.other_definition
        first.approval = second_approval
        with self.assertRaises(ValueError):
            first.save()
        first.refresh_from_db()
        self.assertEqual((first.definition_id, first.approval_id), (self.definition.pk, first_approval.pk))
        replacement = self.make_approval(credential=second_source)
        first.approval = replacement
        first.save(update_fields=["approval", "updated_at"])
        first.refresh_from_db()
        self.assertEqual(first.approval.credential_id, second_source.pk)
