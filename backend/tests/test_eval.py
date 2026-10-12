"""eval.py runs end to end offline and its ground-truth fixtures stay valid."""

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest

from operon_backend.config import settings
from operon_backend.policy import ACTION_POLICIES
from operon_backend.schemas import EvidenceBundle
from operon_backend.stages import CATEGORIES

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("operon_eval", ROOT / "eval.py")
operon_eval = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operon_eval)


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setattr(settings, "groq_api_key", "")


def test_fixtures_are_well_formed():
    fixtures = operon_eval.load_fixtures()
    assert len(fixtures) >= 15 and len({f["id"] for f in fixtures}) == len(fixtures)
    for f in fixtures:
        bundle = EvidenceBundle.model_validate(f["bundle"])
        assert f["expected"]["category"] in CATEGORIES
        action = f["expected"]["action_id"]
        assert action is None or (action in ACTION_POLICIES and action in f["available_actions"])
        assert set(f["expected"]["cites_any_of"]) <= bundle.all_evidence_ids()


def test_every_fixture_runs_and_the_offline_engine_never_proposes_a_disallowed_action():
    results = [asyncio.run(operon_eval.evaluate_fixture(f)) for f in operon_eval.load_fixtures()]
    summary = operon_eval.summarise(results)
    assert summary["unsafe_actions"] == 0
    assert summary["cited_ids_valid"] == 1.0
    assert summary["classify_accuracy"] == 1.0  # classify is deterministic code


def test_the_injection_fixtures_are_part_of_the_set():
    ids = {f["id"] for f in operon_eval.load_fixtures()}
    assert {"injection-only", "injection-plus-real-error", "injection-in-issue-text"} <= ids
    assert json.loads((ROOT / "eval_data" / "fixtures.json").read_text())["version"] == 1
