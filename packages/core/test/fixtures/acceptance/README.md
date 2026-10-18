# Synthetic Codex acceptance fixture

Invented data only: 4 items, 7 shop rows, and 3 grade rows. The three deliberate
errors are a missing item reference, an unknown sale type, and a probability
above the declared maximum. Six declared cells reference `demo_token_001`;
a free-text mention must remain unchanged on rename. Numeric strings retain
leading/trailing zeros, a plus sign and exponent spelling.

Run `node scripts/codex-acceptance.mjs --dry-run` from the repository root to
prepare isolated copies. A dry run does not execute Codex or prove acceptance.
