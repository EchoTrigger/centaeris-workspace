"""Definition publication preserves private history and immutable run provenance."""
from django.contrib.auth import get_user_model
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase
from django.utils import timezone

from .models import (
    Agent, AgentDefinition, AgentDefinitionMember, AgentDefinitionVersion,
    AgentRun, McpBearerCredential, ModelConfig, Session, Workspace,
    WorkspaceMembership,
)


class AgentDefinitionMigrationTests(TransactionTestCase):
    serialized_rollback = True

    def test_forward_migration_preserves_private_history_without_fabricating_definitions(self):
        previous = [("app_core", "0006_transcript_output_capture")]
        target = ("app_core", "0007_agent_definitions")
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        try:
            executor.migrate(previous)
            apps = executor.loader.project_state(previous).apps
            historical = lambda name: apps.get_model("app_core", name)
            user = apps.get_model("auth", "User").objects.create(username="legacy-definition-user")
            workspace = historical("Workspace").objects.create(name="Legacy", createdBy=user)
            membership = historical("WorkspaceMembership").objects.create(workspace=workspace, user=user)
            agent = historical("Agent").objects.create(
                workspace=workspace, owner=user, name="Private", instructions="private instructions")
            session = historical("Session").objects.create(workspace=workspace, owner=user, agent=agent)
            model = historical("ModelConfig").objects.create(displayName="Synthetic")
            run = historical("AgentRun").objects.create(
                workspace=workspace, session=session, user=user, modelConfig=model,
                membership_ref=membership.id, prompt="synthetic prompt", agent_instructions="old run snapshot")
            credential = historical("McpBearerCredential").objects.create(
                plugin_name="synthetic-plugin", credential_ref="synthetic-ref", display_name="Synthetic",
                encrypted_secret="synthetic-encrypted-value", created_by=user, updated_by=user)
            forward = MigrationExecutor(connection)
            self.assertEqual(forward.loader.get_migration(*target).dependencies, previous)
            forward.migrate(latest)
            restored_agent = Agent.objects.get(pk=agent.pk)
            self.assertEqual((restored_agent.workspace_id, restored_agent.owner_id, restored_agent.instructions),
                             (workspace.pk, user.pk, "private instructions"))
            self.assertIsNone(restored_agent.definition_id)
            restored_session = Session.objects.get(pk=session.pk)
            self.assertEqual((restored_session.workspace_id, restored_session.owner_id, restored_session.agent_id),
                             (workspace.pk, user.pk, agent.pk))
            restored_run = AgentRun.objects.get(pk=run.pk)
            self.assertEqual((restored_run.workspace_id, restored_run.user_id, restored_run.session_id,
                              restored_run.membership_ref, restored_run.agent_instructions),
                             (workspace.pk, user.pk, session.pk, membership.pk, "old run snapshot"))
            self.assertIsNone(restored_run.definition_version_id)
            self.assertEqual(McpBearerCredential.objects.get(pk=credential.pk).encrypted_secret,
                             "synthetic-encrypted-value")
            self.assertFalse(AgentDefinition.objects.exists())
            self.assertFalse(AgentDefinitionVersion.objects.exists())
            self.assertFalse(AgentDefinitionMember.objects.exists())
        finally:
            MigrationExecutor(connection).migrate(latest)


class AgentDefinitionModelTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username="definition-owner")
        self.workspace = Workspace.objects.create(name="Definitions", createdBy=self.user)
        self.foreign_workspace = Workspace.objects.create(name="Foreign", createdBy=self.user)
        self.membership = WorkspaceMembership.objects.create(workspace=self.workspace, user=self.user)
        self.foreign_membership = WorkspaceMembership.objects.create(workspace=self.foreign_workspace, user=self.user)
        self.definition = AgentDefinition.objects.create(created_by=self.user, workspace=self.workspace, name="Published", instructions="draft")
        self.version = self.make_version(self.definition, 1, "snapshot one")
        self.definition.published_version = self.version
        self.definition.save(update_fields=["published_version"])
        self.agent = Agent.objects.create(
            workspace=self.workspace, owner=self.user, definition=self.definition,
            name=self.version.name, description=self.version.description,
            instructions=self.version.instructions, avatar_kind=self.version.avatar_kind)
        self.session = Session.objects.create(workspace=self.workspace, owner=self.user, agent=self.agent)
        self.model = ModelConfig.objects.create(displayName="Synthetic")

    def make_version(self, definition, version, instructions):
        return AgentDefinitionVersion.objects.create(
            definition=definition, version=version, name=definition.name, description="",
            instructions=instructions, avatar_kind="centaeris", published_by=self.user, published_at=timezone.now())

    def make_run(self, version=None, instructions=""):
        return AgentRun.objects.create(workspace=self.workspace, session=self.session,
            user=self.user, modelConfig=self.model, prompt="synthetic", definition_version=version,
            agent_instructions=instructions)

    def test_published_version_must_belong_to_definition(self):
        foreign = AgentDefinition.objects.create(created_by=self.user, workspace=self.workspace, name="Other")
        self.definition.published_version = self.make_version(foreign, 1, "other")
        with self.assertRaises(ValueError):
            self.definition.save()

    def test_definition_enums_and_workspace_are_enforced(self):
        for field, value in (("status", "deleted"), ("availability_scope", "public"), ("avatar_kind", "unknown")):
            with self.subTest(field=field):
                setattr(self.definition, field, value)
                with self.assertRaises(ValueError):
                    self.definition.save()
                self.definition.refresh_from_db()
        self.definition.workspace = self.foreign_workspace
        with self.assertRaises(ValueError):
            self.definition.save()

    def test_member_must_belong_to_definition_workspace(self):
        AgentDefinitionMember.objects.create(definition=self.definition, membership=self.membership)
        with self.assertRaises(ValueError):
            AgentDefinitionMember.objects.create(definition=self.definition, membership=self.foreign_membership)

    def test_agent_definition_workspace_and_identity_are_enforced(self):
        foreign = AgentDefinition.objects.create(created_by=self.user, workspace=self.foreign_workspace, name="Foreign")
        with self.assertRaises(ValueError):
            Agent.objects.create(workspace=self.workspace, owner=self.user, name="Wrong", definition=foreign)
        other = AgentDefinition.objects.create(created_by=self.user, workspace=self.workspace, name="Other")
        self.agent.definition = other
        with self.assertRaises(ValueError):
            self.agent.save()

    def test_one_agent_per_owner_definition_and_unbound_agents_remain_valid(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            Agent.objects.create(
                workspace=self.workspace, owner=self.user, definition=self.definition,
                name=self.version.name, description=self.version.description,
                instructions=self.version.instructions, avatar_kind=self.version.avatar_kind)
        for name in ("Unbound one", "Unbound two"):
            self.assertIsNone(Agent.objects.create(workspace=self.workspace, owner=self.user, name=name).definition_id)

    def test_version_snapshot_cannot_be_changed_through_save_or_queryset(self):
        self.version.instructions = "changed"
        with self.assertRaises(ValueError):
            self.version.save()
        with self.assertRaises(ValueError):
            AgentDefinitionVersion.objects.filter(pk=self.version.pk).update(instructions="changed")
        with self.assertRaises(ValueError), transaction.atomic():
            AgentDefinitionVersion.objects.bulk_update([self.version], ["instructions"])
        self.version.refresh_from_db()
        self.assertEqual(self.version.instructions, "snapshot one")

    def test_version_delete_is_rejected(self):
        with self.assertRaises(ValueError):
            self.version.delete()
        with self.assertRaises(ValueError):
            AgentDefinitionVersion.objects.filter(pk=self.version.pk).delete()
        self.assertTrue(AgentDefinitionVersion.objects.filter(pk=self.version.pk).exists())

    def test_version_upsert_cannot_replace_published_content(self):
        replacement = AgentDefinitionVersion(id=self.version.id, definition=self.definition, version=1,
            name="Changed", instructions="Changed", published_by=self.user)
        with self.assertRaises(ValueError), transaction.atomic():
            AgentDefinitionVersion.objects.bulk_create([replacement], update_conflicts=True,
                update_fields=["name", "instructions"], unique_fields=["id"])
        self.version.refresh_from_db()
        self.assertEqual(self.version.instructions, "snapshot one")

    def test_new_version_object_cannot_overwrite_existing_identity(self):
        replacement = AgentDefinitionVersion(id=self.version.id, definition=self.definition, version=1,
            name="Changed", instructions="Changed", published_by=self.user)
        with self.assertRaises(IntegrityError), transaction.atomic():
            replacement.save()
        self.version.refresh_from_db()
        self.assertEqual(self.version.instructions, "snapshot one")

    def test_version_numbers_are_positive_and_unique_per_definition(self):
        with self.assertRaises(ValueError):
            self.make_version(self.definition, 0, "invalid")
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.make_version(self.definition, 1, "duplicate")

    def test_existing_private_agent_cannot_acquire_a_definition(self):
        private = Agent.objects.create(workspace=self.workspace, owner=self.user, name="Existing private")
        private.definition = self.definition
        with self.assertRaises(ValueError):
            private.save()
        private.refresh_from_db()
        self.assertIsNone(private.definition_id)

    def test_run_requires_matching_definition_and_exact_snapshot(self):
        with self.assertRaises(ValueError):
            self.make_run(self.version, "draft")
        foreign = AgentDefinition.objects.create(created_by=self.user, workspace=self.workspace, name="Other")
        other_version = self.make_version(foreign, 1, "other")
        with self.assertRaises(ValueError):
            self.make_run(other_version, "other")
        run = self.make_run(self.version, "snapshot one")
        newer = self.make_version(self.definition, 2, "snapshot two")
        run.definition_version = newer
        run.agent_instructions = "snapshot two"
        with self.assertRaises(ValueError):
            run.save()
        run.refresh_from_db()
        self.assertEqual((run.definition_version_id, run.agent_instructions), (self.version.pk, "snapshot one"))

    def test_draft_changes_do_not_change_version_or_run_snapshot(self):
        run = self.make_run(self.version, "snapshot one")
        self.definition.instructions = "edited draft"
        self.definition.save()
        self.version.refresh_from_db()
        run.refresh_from_db()
        self.assertEqual(self.version.instructions, "snapshot one")
        self.assertEqual(run.agent_instructions, "snapshot one")
