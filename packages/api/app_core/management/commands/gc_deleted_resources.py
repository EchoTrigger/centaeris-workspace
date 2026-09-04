from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from app_core.deleted_resource_gc import (
    collect_deleted_resource_gc,
    collect_orphaned_library_gc,
    expire_trash,
)
from app_core.trash_retention import trash_cutoff


class Command(BaseCommand):
    help = "Reclaim tombstoned source, library, and artifact resources after retention."

    def add_arguments(self, parser):
        parser.add_argument("--older-than-seconds", type=int, default=30 * 24 * 60 * 60)
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument(
            "--orphaned-library",
            action="store_true",
            help="Also scan users/*/library for storage bytes without a database owner.",
        )

    def handle(self, *args, **options):
        older_than_seconds = options["older_than_seconds"]
        if older_than_seconds < 0:
            raise CommandError("--older-than-seconds must be non-negative")
        dry_run = options["dry_run"]
        cutoff = timezone.now() - timedelta(seconds=older_than_seconds)
        expired = expire_trash(trash_cutoff(), dry_run)
        action = "Would expire" if dry_run else "Expired"
        self.stdout.write(
            f"{action} {expired.agents} agents, {expired.sessions} sessions, "
            f"{expired.sources} sources, {expired.library_objects} library objects"
        )
        report = collect_deleted_resource_gc(cutoff, dry_run)
        for resource in report.planned + report.cleaned:
            action = "Would clean" if dry_run else "Cleaned"
            self.stdout.write(
                f"{action} {resource.ownerKind}:{resource.ownerId} generation="
                f"{resource.deletionGeneration} {resource.resourceKind}"
            )
        for resource in report.blocked:
            self.stdout.write(
                f"Blocked {resource.ownerKind}:{resource.ownerId} generation="
                f"{resource.deletionGeneration} {resource.resourceKind}"
            )
        action = "Would clean" if dry_run else "Cleaned"
        self.stdout.write(
            f"{action} {len(report.planned) if dry_run else len(report.cleaned)} deleted resources; "
            f"blocked {len(report.blocked)}; failed {len(report.failures)}"
        )
        if report.failures:
            raise CommandError(f"GC failed for {len(report.failures)} deleted resources")
        if options["orphaned_library"]:
            orphan_report = collect_orphaned_library_gc(cutoff, dry_run)
            action = "Would clean" if dry_run else "Cleaned"
            for key in orphan_report.planned + orphan_report.cleaned:
                self.stdout.write(f"{action} orphaned library key {key}")
            for failure in orphan_report.failures:
                self.stdout.write(f"Failed orphaned library key {failure}")
            self.stdout.write(
                f"{action} {len(orphan_report.planned) if dry_run else len(orphan_report.cleaned)} "
                f"orphaned library keys; failed {len(orphan_report.failures)}"
            )
            if orphan_report.failures:
                raise CommandError(
                    f"Orphaned library GC failed for {len(orphan_report.failures)} keys"
                )
