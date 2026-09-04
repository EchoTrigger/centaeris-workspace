# Document processing

## Required service

The document-processor image is a required Runtime dependency. Runtime verifies
that the configured image exists before serving AgentRuns. The image uses a
read-only root, no network, dropped capabilities, and bounded temporary space
for its specification check; per-document processing receives a separate
request-bound execution profile.

## Supported classes

The processor provides native inspection or conversion for supported Office,
PDF, text, and image inputs. OCR is used when a native representation is
insufficient and the selected specification requires it. The representation is
bound to the source version and processing specification.

## Streaming

Long documents are processed incrementally. There is no fixed page-count
ceiling. Each page or frame is handled in order and output is written as it is
accepted, while pixel, output-size, timeout, process, and memory budgets remain
enforced. A permanent error stops immediately; repeated transient I/O or timeout
errors stop after the bounded retry policy.

Tool completion follows terminal processor state. The browser activity row must
disappear on success, failure, cancellation, interruption, or terminal
AgentRun state.

## Measurement boundary

Synthetic and native-parser tests cover more than 1,000 pages or frames, UTF-8
locations, bounded output, and manifest validation. They do not prove OCR
quality on every real document.

Model reuse is currently process-local. Cross-document warm reuse and the
historical startup reduction have not been remeasured and must not be claimed
without a current controlled run.
