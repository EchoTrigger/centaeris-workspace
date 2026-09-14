# Frontend manual acceptance

Run this checklist against a production Web build before a release that changes
Workspace routes, conversation rendering, administration, or material previews.
Record the tested commit, browser/version, viewport, account role, and result.

## Conversation workbench

- Open short and long Sessions, load one older page per deliberate upward read,
  and confirm a visible block keeps its viewport offset when content is prepended.
- Let reasoning, tool activity, and the final answer stream while detached from
  the bottom; confirm following resumes only after returning to latest.
- Expand tool groups before and after completion, including a large output and a
  failed tool; confirm stable ordering, final status, and bounded detail reads.
- Switch routes or Sessions while history, stream, attachment, and preview
  requests are in flight; confirm late responses cannot overwrite the new view.
- Check the context panel, status placement, Markdown/code rendering, citations,
  and attachment cards at desktop and narrow viewports.

## Identity and administration

- Sign in, sign out, reload a protected deep link, and verify an expired or
  unauthorized session cannot expose cached Workspace content.
- Exercise invitation activation, member role changes, group membership, model
  administration, and direct settings URLs with both authorized and denied
  accounts.
- Enable, configure, fail, recover, and disable a Plugin; confirm credentials and
  capabilities remain isolated between Plugins and Workspaces.

## Materials and appearance

- Upload, open, search, preview, and remove representative image, code, PDF, and
  supported Office files; verify library/trash state and access revocation.
- Switch light/dark theme and language, then reload; confirm the last choice,
  layout, icons, interpolation, and focus indicators remain coherent.
- Compare the main workbench at 100%, 150%, and 200% zoom for clipping, overlap,
  unintended horizontal scrolling, and unreadable contrast.
