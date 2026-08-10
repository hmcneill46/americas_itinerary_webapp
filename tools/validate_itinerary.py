#!/usr/bin/env python3
from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import validate_itinerary  # noqa: E402

path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'data' / 'itinerary.json'
data = json.loads(path.read_text(encoding='utf-8'))
result = validate_itinerary(data)
for migration in result.get('migrations', []):
    print(f'MIGRATION: {migration} (validated in memory; source file unchanged)')
for warning in result['warnings']:
    print(f'WARNING: {warning}')
for error in result['errors']:
    print(f'ERROR: {error}')
if result['errors']:
    raise SystemExit(1)
validated = result['itinerary']
print(
    f'Valid schema v{validated["schema_version"]} itinerary: '
    f'{len(validated["days"])} days, {len(validated["events"])} events, {len(validated["visits"])} visits.'
)
