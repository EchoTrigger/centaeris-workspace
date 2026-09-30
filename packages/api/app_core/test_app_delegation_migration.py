from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

from app_core.models import Agent, AgentRun, BusinessApplication, HostedOperationReceipt, McpBearerCredential, Session, UserAppDelegation


class AppDelegationMigrationTests(TransactionTestCase):
    serialized_rollback = True

    def test_forward_migration_preserves_private_history_without_fabricating_app_authority(self):
        previous = [("app_core", "0008_assistant_connector_authority")]
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        try:
            executor.migrate(previous)
            apps = executor.loader.project_state(previous).apps
            historical = lambda name: apps.get_model("app_core", name)
            user = apps.get_model("auth", "User").objects.create(username="legacy-app-owner")
            workspace = historical("Workspace").objects.create(name="Legacy", createdBy=user)
            membership = historical("WorkspaceMembership").objects.create(workspace=workspace, user=user)
            agent = historical("Agent").objects.create(workspace=workspace, owner=user, name="Private", instructions="private")
            session = historical("Session").objects.create(workspace=workspace, owner=user, agent=agent)
            model = historical("ModelConfig").objects.create(displayName="Fixture")
            run = historical("AgentRun").objects.create(workspace=workspace, session=session, user=user,
                modelConfig=model, membership_ref=membership.id, prompt="Fixture", agent_instructions="retained snapshot")
            receipt = historical("HostedOperationReceipt").objects.create(user=user, workspace=workspace,
                command="submitMessage", operationId="old-receipt", requestDigest="a" * 64,
                sessionId=session.id, agentRunId=run.id, turnId=run.turn_id)
            credential = historical("McpBearerCredential").objects.create(plugin_name="fixture", credential_ref="legacy",
                display_name="Fixture", encrypted_secret="synthetic-ciphertext", created_by=user, updated_by=user)
            MigrationExecutor(connection).migrate(latest)
            self.assertEqual((Agent.objects.get(pk=agent.pk).owner_id, Session.objects.get(pk=session.pk).agent_id),
                             (user.pk, agent.pk))
            restored = AgentRun.objects.get(pk=run.pk)
            self.assertEqual((restored.user_id, restored.session_id, restored.membership_ref, restored.agent_instructions),
                             (user.pk, session.pk, membership.pk, "retained snapshot"))
            self.assertIsNone(restored.acting_app_id)
            self.assertIsNone(restored.app_delegation_id)
            saved = HostedOperationReceipt.objects.get(pk=receipt.pk)
            self.assertEqual((saved.sessionId, saved.agentRunId, saved.turnId, saved.requestDigest),
                             (session.id, run.id, run.turn_id, "a" * 64))
            self.assertIsNone(saved.acting_app_id)
            self.assertIsNone(saved.app_delegation_id)
            self.assertEqual(McpBearerCredential.objects.get(pk=credential.pk).encrypted_secret, "synthetic-ciphertext")
            self.assertFalse(BusinessApplication.objects.exists())
            self.assertFalse(UserAppDelegation.objects.exists())
        finally:
            MigrationExecutor(connection).migrate(latest)
