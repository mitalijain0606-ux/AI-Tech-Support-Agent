from typing import Any

from operon_backend.schemas import PolicyDecision

# Closed enum of permitted actions and their default policy evaluations
ACTION_POLICIES: dict[str, str] = {
    # Read-only
    "inspect_page": "ALLOW",
    "console_errors": "ALLOW",
    "network_requests": "ALLOW",
    # Low-risk write
    "reload": "ALLOW",
    "refresh_auth_token": "ALLOW",
    # Destructive write
    "clear_storage_key": "REQUIRE_APPROVAL",
    "unregister_service_worker": "REQUIRE_APPROVAL",
    # Sensitive
    "switch_workspace": "REQUIRE_APPROVAL",
    "reset_user_preference": "REQUIRE_APPROVAL",
    "screenshot": "REQUIRE_APPROVAL",
}


def evaluate(
    action_id: str,
    params: dict[str, Any] | None = None,
    provider_capabilities: list[str] | None = None,
) -> PolicyDecision:
    """
    Deterministically evaluates an action against the closed action enum,
    action parameter schema, and provider capabilities.
    """
    params = params or {}
    provider_capabilities = provider_capabilities or []

    # 1. Check if action is in closed enum
    if action_id not in ACTION_POLICIES:
        return PolicyDecision(
            action_id=action_id,
            decision="DENY",
            reason=f"Action '{action_id}' is not in the approved action enum.",
            validated_params={},
        )

    # 2. Check provider capability support
    if provider_capabilities and action_id not in provider_capabilities:
        return PolicyDecision(
            action_id=action_id,
            decision="DENY",
            reason=f"Action '{action_id}' is not supported by the capability provider.",
            validated_params={},
        )

    # 3. Validate per-action parameters
    validated_params: dict[str, Any] = {}

    if action_id == "clear_storage_key":
        key = params.get("key")
        if not key or not isinstance(key, str) or not key.strip():
            return PolicyDecision(
                action_id=action_id,
                decision="DENY",
                reason="Action 'clear_storage_key' requires a non-empty string parameter 'key'.",
                validated_params={},
            )
        validated_params["key"] = key.strip()

    elif action_id == "unregister_service_worker":
        if "scope" in params and isinstance(params["scope"], str):
            validated_params["scope"] = params["scope"]

    elif action_id == "reload":
        validated_params["ignore_cache"] = bool(params.get("ignore_cache", False))

    elif action_id == "inspect_page":
        if "selector" in params and isinstance(params["selector"], str):
            validated_params["selector"] = params["selector"]

    else:
        validated_params = dict(params)

    # 4. Return policy decision
    base_decision = ACTION_POLICIES[action_id]
    if base_decision == "REQUIRE_APPROVAL":
        reason = f"Action '{action_id}' is destructive or sensitive and requires explicit human approval."
    else:
        reason = f"Action '{action_id}' is safe or read-only and is allowed automatically."

    return PolicyDecision(
        action_id=action_id,
        decision=base_decision,
        reason=reason,
        validated_params=validated_params,
    )
