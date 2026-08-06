# Observe evaluation fixtures

Each task run copies a pinned directory from this folder into an isolated
workspace. The initial fixture is intentionally small so the smoke harness can
verify the three arms without network or repository checkout. Full experiments
should replace or extend it with reviewed repository snapshots and record their
source commit and checksum in the run manifest.
