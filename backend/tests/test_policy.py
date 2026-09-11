from operon_backend.policy import evaluate


def test_policy_allow_safe_actions():
    decision = evaluate(
        action_id="reload",
        params={"ignore_cache": True},
        provider_capabilities=["reload", "inspect_page"],
    )
    assert decision.decision == "ALLOW"
    assert decision.validated_params["ignore_cache"] is True

    decision_inspect = evaluate(
        action_id="inspect_page",
        params={},
        provider_capabilities=["inspect_page"],
    )
    assert decision_inspect.decision == "ALLOW"


def test_policy_require_approval_destructive_actions():
    # clear_storage_key
    decision = evaluate(
        action_id="clear_storage_key",
        params={"key": "operon_demo_cache"},
        provider_capabilities=["clear_storage_key"],
    )
    assert decision.decision == "REQUIRE_APPROVAL"
    assert decision.validated_params["key"] == "operon_demo_cache"

    # unregister_service_worker
    decision_sw = evaluate(
        action_id="unregister_service_worker",
        params={"scope": "/"},
        provider_capabilities=["unregister_service_worker"],
    )
    assert decision_sw.decision == "REQUIRE_APPROVAL"
    assert decision_sw.validated_params["scope"] == "/"


def test_policy_denies_missing_parameters():
    # clear_storage_key without key
    decision = evaluate(
        action_id="clear_storage_key",
        params={},
        provider_capabilities=["clear_storage_key"],
    )
    assert decision.decision == "DENY"
    assert "requires a non-empty string parameter 'key'" in decision.reason


def test_policy_denies_unsupported_capability():
    decision = evaluate(
        action_id="clear_storage_key",
        params={"key": "operon_demo_cache"},
        provider_capabilities=["reload"],  # clear_storage_key not in capabilities
    )
    assert decision.decision == "DENY"
    assert "not supported by the capability provider" in decision.reason


def test_policy_denies_unknown_actions():
    decision = evaluate(
        action_id="drop_database",
        params={},
        provider_capabilities=["drop_database"],
    )
    assert decision.decision == "DENY"
    assert "not in the approved action enum" in decision.reason

    decision_arbitrary = evaluate(
        action_id="execute_script",
        params={"code": "alert(1)"},
        provider_capabilities=[],
    )
    assert decision_arbitrary.decision == "DENY"
